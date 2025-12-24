// ========================================
// Routes: Session Management
// ========================================
// Endpoints para gerenciamento de sessões WhatsApp

const express = require('express');
const router = express.Router();
const Session = require('../models/session');
const sessionManager = require('../services/sessionManager');
const whatsappService = require('../services/whatsappService');
const { validateApiKey, authorizeSession, checkSessionLimit } = require('../middleware/authMiddleware');
const { createQRRateLimiter, createCreationRateLimiter } = require('../middleware/rateLimiter');

// Aplicar autenticação em todas as rotas
router.use(validateApiKey);

/**
 * POST /api/v1/sessions
 * Cria uma nova sessão WhatsApp
 */
router.post('/',
    createCreationRateLimiter(),
    checkSessionLimit(),
    async (req, res) => {
        try {
            const { session_name, webhook_url, webhook_signature_key, metadata } = req.body;

            // Validações
            if (!session_name || !webhook_url || !webhook_signature_key) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Missing required fields: session_name, webhook_url, webhook_signature_key'
                });
            }

            // Verificar se nome já existe
            const existing = await Session.findByName(session_name);
            if (existing) {
                return res.status(409).json({
                    status: 'error',
                    message: 'Session name already exists'
                });
            }

            // Criar sessão no banco
            const session = await Session.create({
                session_name,
                api_key_id: req.apiKeyId,
                webhook_url,
                webhook_signature_key,
                metadata: metadata || {}
            });

            res.status(201).json({
                status: 'success',
                data: {
                    session_id: session.id,
                    session_name: session.session_name,
                    status: session.status,
                    webhook_url: session.webhook_url,
                    created_at: session.created_at
                }
            });
        } catch (error) {
            console.error('[SESSIONS] Erro ao criar sessão:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to create session',
                detail: error.message
            });
        }
    }
);

/**
 * GET /api/v1/sessions
 * Lista todas as sessões da API key
 */
router.get('/', async (req, res) => {
    try {
        const sessions = await Session.findByApiKey(req.apiKeyId);

        res.json({
            status: 'success',
            data: sessions.map(s => ({
                session_id: s.id,
                session_name: s.session_name,
                status: s.status,
                phone_number: s.phone_number,
                last_connected_at: s.last_connected_at,
                created_at: s.created_at
            })),
            count: sessions.length
        });
    } catch (error) {
        console.error('[SESSIONS] Erro ao listar sessões:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to list sessions'
        });
    }
});

/**
 * GET /api/v1/sessions/:session_id
 * Obtém detalhes de uma sessão
 */
router.get('/:session_id', authorizeSession, async (req, res) => {
    try {
        const session = req.session;
        const isActive = sessionManager.getSession(session.id) !== undefined;

        res.json({
            status: 'success',
            data: {
                session_id: session.id,
                session_name: session.session_name,
                status: session.status,
                phone_number: session.phone_number,
                webhook_url: session.webhook_url,
                last_connected_at: session.last_connected_at,
                created_at: session.created_at,
                updated_at: session.updated_at,
                is_active: isActive,
                metadata: session.metadata
            }
        });
    } catch (error) {
        console.error('[SESSIONS] Erro ao obter sessão:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to get session details'
        });
    }
});

/**
 * POST /api/v1/sessions/:session_id/connect
 * Inicia conexão de uma sessão (gera QR code)
 */
router.post('/:session_id/connect',
    authorizeSession,
    async (req, res) => {
        try {
            const sessionId = req.params.session_id;

            // Verificar se já está conectada
            const activeSocket = sessionManager.getSession(sessionId);
            if (activeSocket && activeSocket.user) {
                return res.json({
                    status: 'success',
                    message: 'Session already connected',
                    data: {
                        status: 'connected',
                        phone_number: activeSocket.user.id.split(':')[0]
                    }
                });
            }

            // Iniciar conexão
            await sessionManager.createSession(sessionId);

            res.json({
                status: 'success',
                message: 'Connection initiated. Poll /qr endpoint for QR code.',
                data: {
                    session_id: sessionId,
                    status: 'connecting'
                }
            });
        } catch (error) {
            console.error('[SESSIONS] Erro ao conectar sessão:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to initiate connection',
                detail: error.message
            });
        }
    }
);

/**
 * GET /api/v1/sessions/:session_id/qr
 * Obtém QR code para autenticação (long-polling)
 */
router.get('/:session_id/qr',
    authorizeSession,
    createQRRateLimiter(),
    async (req, res) => {
        try {
            const sessionId = req.params.session_id;

            // Verificar se está conectada
            const activeSocket = sessionManager.getSession(sessionId);
            if (activeSocket && activeSocket.user) {
                return res.json({
                    status: 'success',
                    message: 'Session already connected',
                    data: {
                        status: 'connected',
                        phone_number: activeSocket.user.id.split(':')[0]
                    }
                });
            }

            // Buscar QR do cache ou banco
            let qrData = sessionManager.getQRCode(sessionId);

            if (!qrData || !qrData.qr) {
                // Buscar do banco
                const session = await Session.findById(sessionId);

                if (session.qr_code && session.qr_expires_at) {
                    const expiresAt = new Date(session.qr_expires_at);

                    if (expiresAt > new Date()) {
                        qrData = {
                            qr: session.qr_code,
                            expiresAt
                        };
                    }
                }
            }

            if (!qrData || !qrData.qr) {
                return res.json({
                    status: 'pending',
                    message: 'QR code not yet available. Please initiate connection first.',
                    data: {
                        session_id: sessionId,
                        status: req.session.status
                    }
                });
            }

            // Converter QR para data URL
            const qrDataURL = await whatsappService.qrToDataURL(qrData.qr);

            res.json({
                status: 'success',
                data: {
                    qr_code: qrDataURL,
                    expires_at: qrData.expiresAt.toISOString(),
                    session_id: sessionId
                }
            });
        } catch (error) {
            console.error('[SESSIONS] Erro ao obter QR:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to get QR code',
                detail: error.message
            });
        }
    }
);

/**
 * POST /api/v1/sessions/:session_id/disconnect
 * Desconecta uma sessão sem deletar
 */
router.post('/:session_id/disconnect',
    authorizeSession,
    async (req, res) => {
        try {
            const sessionId = req.params.session_id;

            await sessionManager.disconnectSession(sessionId);

            res.json({
                status: 'success',
                message: 'Session disconnected successfully',
                data: {
                    session_id: sessionId,
                    status: 'disconnected'
                }
            });
        } catch (error) {
            console.error('[SESSIONS] Erro ao desconectar sessão:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to disconnect session',
                detail: error.message
            });
        }
    }
);

/**
 * DELETE /api/v1/sessions/:session_id
 * Deleta uma sessão permanentemente
 */
router.delete('/:session_id',
    authorizeSession,
    async (req, res) => {
        try {
            const sessionId = req.params.session_id;

            // Desconectar se estiver ativa
            await sessionManager.disconnectSession(sessionId);

            // Deletar do banco
            await Session.remove(sessionId);

            res.json({
                status: 'success',
                message: 'Session deleted successfully',
                data: {
                    session_id: sessionId
                }
            });
        } catch (error) {
            console.error('[SESSIONS] Erro ao deletar sessão:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to delete session',
                detail: error.message
            });
        }
    }
);

/**
 * GET /api/v1/sessions/:session_id/logs
 * Obtém logs de uma sessão
 */
router.get('/:session_id/logs',
    authorizeSession,
    async (req, res) => {
        try {
            const { pool } = require('../config/database');
            const sessionId = req.params.session_id;
            const limit = parseInt(req.query.limit || '50', 10);
            const offset = parseInt(req.query.offset || '0', 10);

            const result = await pool.query(
                `SELECT id, event_type, details, created_at
                 FROM session_logs
                 WHERE session_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2 OFFSET $3`,
                [sessionId, limit, offset]
            );

            res.json({
                status: 'success',
                data: result.rows,
                count: result.rows.length
            });
        } catch (error) {
            console.error('[SESSIONS] Erro ao obter logs:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to get session logs'
            });
        }
    }
);

module.exports = router;

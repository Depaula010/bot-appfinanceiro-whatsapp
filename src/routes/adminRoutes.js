// ========================================
// Routes: Admin
// ========================================
// Endpoints administrativos (criação de API keys, estatísticas, etc)

const express = require('express');
const router = express.Router();
const ApiKey = require('../models/apiKey');
const Session = require('../models/session');
const sessionManager = require('../services/sessionManager');
const { generateApiKey } = require('../utils/crypto');
const { validateAdminKey } = require('../middleware/authMiddleware');
const { createAdminRateLimiter } = require('../middleware/rateLimiter');

// Aplicar autenticação admin em todas as rotas
router.use(validateAdminKey);
router.use(createAdminRateLimiter());

/**
 * POST /api/v1/admin/api-keys
 * Cria uma nova API key
 */
router.post('/api-keys', async (req, res) => {
    try {
        const {
            project_name,
            description,
            rate_limit_per_minute,
            expires_at,
            environment
        } = req.body;

        // Validações
        if (!project_name) {
            return res.status(400).json({
                status: 'error',
                message: 'Missing required field: project_name'
            });
        }

        // Gerar API key
        const env = environment || 'live';
        const apiKey = generateApiKey(env);

        // Criar no banco
        const keyRecord = await ApiKey.create(apiKey, {
            project_name,
            description: description || null,
            rate_limit_per_minute: rate_limit_per_minute || 60,
            expires_at: expires_at ? new Date(expires_at) : null
        });

        res.status(201).json({
            status: 'success',
            message: 'API key created successfully',
            data: {
                api_key: apiKey, // IMPORTANTE: Mostrado apenas uma vez
                api_key_id: keyRecord.id,
                key_prefix: keyRecord.key_prefix,
                project_name: keyRecord.project_name,
                description: keyRecord.description,
                rate_limit_per_minute: keyRecord.rate_limit_per_minute,
                is_active: keyRecord.is_active,
                created_at: keyRecord.created_at,
                expires_at: keyRecord.expires_at
            },
            warning: 'Save this API key securely. It cannot be retrieved again.'
        });
    } catch (error) {
        console.error('[ADMIN] Erro ao criar API key:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to create API key',
            detail: error.message
        });
    }
});

/**
 * GET /api/v1/admin/api-keys
 * Lista todas as API keys
 */
router.get('/api-keys', async (req, res) => {
    try {
        const { is_active, limit, offset } = req.query;

        const filters = {};
        if (is_active !== undefined) {
            filters.is_active = is_active === 'true';
        }
        if (limit) filters.limit = parseInt(limit, 10);
        if (offset) filters.offset = parseInt(offset, 10);

        const keys = await ApiKey.findAll(filters);

        res.json({
            status: 'success',
            data: keys,
            count: keys.length
        });
    } catch (error) {
        console.error('[ADMIN] Erro ao listar API keys:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to list API keys'
        });
    }
});

/**
 * GET /api/v1/admin/api-keys/:key_id
 * Obtém detalhes de uma API key
 */
router.get('/api-keys/:key_id', async (req, res) => {
    try {
        const keyId = req.params.key_id;
        const key = await ApiKey.findById(keyId);

        if (!key) {
            return res.status(404).json({
                status: 'error',
                message: 'API key not found'
            });
        }

        // Buscar sessões associadas
        const sessions = await Session.findByApiKey(keyId);

        res.json({
            status: 'success',
            data: {
                ...key,
                sessions_count: sessions.length,
                sessions: sessions.map(s => ({
                    session_id: s.id,
                    session_name: s.session_name,
                    status: s.status
                }))
            }
        });
    } catch (error) {
        console.error('[ADMIN] Erro ao obter API key:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to get API key details'
        });
    }
});

/**
 * PATCH /api/v1/admin/api-keys/:key_id
 * Atualiza uma API key
 */
router.patch('/api-keys/:key_id', async (req, res) => {
    try {
        const keyId = req.params.key_id;
        const updates = {};

        // Apenas campos permitidos
        if (req.body.description !== undefined) updates.description = req.body.description;
        if (req.body.rate_limit_per_minute !== undefined) {
            updates.rate_limit_per_minute = parseInt(req.body.rate_limit_per_minute, 10);
        }
        if (req.body.is_active !== undefined) updates.is_active = req.body.is_active;
        if (req.body.expires_at !== undefined) {
            updates.expires_at = req.body.expires_at ? new Date(req.body.expires_at) : null;
        }

        const updated = await ApiKey.update(keyId, updates);

        if (!updated) {
            return res.status(404).json({
                status: 'error',
                message: 'API key not found'
            });
        }

        res.json({
            status: 'success',
            message: 'API key updated successfully',
            data: updated
        });
    } catch (error) {
        console.error('[ADMIN] Erro ao atualizar API key:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to update API key',
            detail: error.message
        });
    }
});

/**
 * DELETE /api/v1/admin/api-keys/:key_id
 * Revoga (desativa) uma API key
 */
router.delete('/api-keys/:key_id', async (req, res) => {
    try {
        const keyId = req.params.key_id;
        const permanent = req.query.permanent === 'true';

        if (permanent) {
            // Deletar permanentemente (também deleta todas as sessões)
            await ApiKey.remove(keyId);
            res.json({
                status: 'success',
                message: 'API key permanently deleted'
            });
        } else {
            // Apenas desativar (soft delete)
            await ApiKey.deactivate(keyId);
            res.json({
                status: 'success',
                message: 'API key deactivated'
            });
        }
    } catch (error) {
        console.error('[ADMIN] Erro ao revogar API key:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to revoke API key',
            detail: error.message
        });
    }
});

/**
 * GET /api/v1/admin/stats
 * Estatísticas gerais do sistema
 */
router.get('/stats', async (req, res) => {
    try {
        const { pool } = require('../config/database');
        const { getPoolStats } = require('../config/database');

        // Estatísticas de API keys
        const totalKeys = await ApiKey.count(false);
        const activeKeys = await ApiKey.count(true);

        // Estatísticas de sessões
        const sessionsResult = await pool.query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'connected') as connected,
                COUNT(*) FILTER (WHERE status = 'disconnected') as disconnected,
                COUNT(*) FILTER (WHERE status = 'connecting') as connecting,
                COUNT(*) FILTER (WHERE status = 'failed') as failed
            FROM sessions
        `);

        const sessionStats = sessionsResult.rows[0];

        // Estatísticas do session manager
        const managerStats = sessionManager.getStats();

        // Estatísticas do pool PostgreSQL
        const poolStats = getPoolStats();

        // Logs recentes
        const recentLogsResult = await pool.query(`
            SELECT event_type, COUNT(*) as count
            FROM session_logs
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY event_type
            ORDER BY count DESC
        `);

        res.json({
            status: 'success',
            data: {
                api_keys: {
                    total: totalKeys,
                    active: activeKeys,
                    inactive: totalKeys - activeKeys
                },
                sessions: {
                    total: parseInt(sessionStats.total, 10),
                    connected: parseInt(sessionStats.connected, 10),
                    disconnected: parseInt(sessionStats.disconnected, 10),
                    connecting: parseInt(sessionStats.connecting, 10),
                    failed: parseInt(sessionStats.failed, 10)
                },
                session_manager: managerStats,
                database_pool: poolStats,
                recent_events_24h: recentLogsResult.rows,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('[ADMIN] Erro ao obter estatísticas:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to get statistics',
            detail: error.message
        });
    }
});

/**
 * GET /api/v1/admin/sessions
 * Lista todas as sessões do sistema (cross-API keys)
 */
router.get('/sessions', async (req, res) => {
    try {
        const { status, limit, offset } = req.query;

        const filters = {};
        if (status) filters.status = status;
        if (limit) filters.limit = parseInt(limit, 10);
        if (offset) filters.offset = parseInt(offset, 10);

        const sessions = await Session.findAll(filters);

        res.json({
            status: 'success',
            data: sessions,
            count: sessions.length
        });
    } catch (error) {
        console.error('[ADMIN] Erro ao listar sessões:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to list sessions'
        });
    }
});

/**
 * POST /api/v1/admin/cleanup-idle
 * Desconecta sessões idle (sem atividade)
 */
router.post('/cleanup-idle', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours || '24', 10);

        const idleSessions = await Session.findIdleSessions(hours);

        for (const session of idleSessions) {
            try {
                await sessionManager.disconnectSession(session.id);
                console.log(`[ADMIN] Sessão idle desconectada: ${session.id}`);
            } catch (error) {
                console.error(`[ADMIN] Erro ao desconectar ${session.id}:`, error);
            }
        }

        res.json({
            status: 'success',
            message: `Cleanup completed. ${idleSessions.length} idle sessions disconnected.`,
            data: {
                disconnected: idleSessions.length,
                sessions: idleSessions.map(s => ({
                    session_id: s.id,
                    session_name: s.session_name,
                    last_connected_at: s.last_connected_at
                }))
            }
        });
    } catch (error) {
        console.error('[ADMIN] Erro em cleanup:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to cleanup idle sessions',
            detail: error.message
        });
    }
});

module.exports = router;

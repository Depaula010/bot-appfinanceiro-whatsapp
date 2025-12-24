// ========================================
// Routes: Message Sending
// ========================================
// Endpoints para envio de mensagens e imagens

const express = require('express');
const router = express.Router();
const sessionManager = require('../services/sessionManager');
const whatsappService = require('../services/whatsappService');
const { validateApiKey, authorizeSession } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/rateLimiter');

// Aplicar autenticação e rate limiting
router.use(validateApiKey);
router.use(createRateLimiter());

/**
 * POST /api/v1/sessions/:session_id/send-message
 * Envia mensagem de texto
 */
router.post('/:session_id/send-message',
    authorizeSession,
    async (req, res) => {
        try {
            const sessionId = req.params.session_id;
            const { numero, mensagem } = req.body;

            // Validações
            if (!numero || !mensagem) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Missing required fields: numero, mensagem'
                });
            }

            // Validar número
            if (!whatsappService.validarListaNumeros([numero]).valid.length) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid WhatsApp number format'
                });
            }

            // Verificar se sessão está conectada
            const socket = sessionManager.getSession(sessionId);
            if (!socket || !socket.user) {
                return res.status(503).json({
                    status: 'error',
                    message: 'Session not connected. Please connect first.'
                });
            }

            // Sanitizar mensagem
            const mensagemSanitizada = whatsappService.sanitizarTexto(mensagem);
            const mensagemTruncada = whatsappService.truncarMensagem(mensagemSanitizada);

            // Enviar mensagem
            const response = await sessionManager.sendMessage(
                sessionId,
                numero,
                mensagemTruncada
            );

            res.json({
                status: 'sucesso',
                mensagem: 'Mensagem enviada com sucesso.',
                data: {
                    message_id: response.key.id,
                    to: numero,
                    timestamp: new Date().toISOString()
                }
            });
        } catch (error) {
            console.error('[MESSAGES] Erro ao enviar mensagem:', error);

            if (error.message === 'Number not found on WhatsApp') {
                return res.status(404).json({
                    status: 'erro',
                    mensagem: 'Número não encontrado no WhatsApp.'
                });
            }

            res.status(500).json({
                status: 'erro',
                mensagem: 'Falha ao enviar mensagem',
                detalhe: error.message
            });
        }
    }
);

/**
 * POST /api/v1/sessions/:session_id/send-image
 * Envia imagem com caption opcional
 */
router.post('/:session_id/send-image',
    authorizeSession,
    async (req, res) => {
        try {
            const sessionId = req.params.session_id;
            const { numero, imagem, legenda } = req.body;

            // Validações
            if (!numero || !imagem) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Missing required fields: numero, imagem (base64)'
                });
            }

            // Validar número
            if (!whatsappService.validarListaNumeros([numero]).valid.length) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid WhatsApp number format'
                });
            }

            // Verificar se sessão está conectada
            const socket = sessionManager.getSession(sessionId);
            if (!socket || !socket.user) {
                return res.status(503).json({
                    status: 'error',
                    message: 'Session not connected. Please connect first.'
                });
            }

            // Converter base64 para buffer
            let imageBuffer;
            try {
                imageBuffer = whatsappService.base64ToBuffer(imagem);
            } catch (error) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid base64 image data'
                });
            }

            // Validar imagem
            if (!whatsappService.validarImagem(imageBuffer)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid image format. Supported: JPEG, PNG, GIF'
                });
            }

            // Sanitizar caption
            const caption = legenda ? whatsappService.sanitizarTexto(legenda) : '';

            // Enviar imagem
            const response = await sessionManager.sendImage(
                sessionId,
                numero,
                imageBuffer,
                caption
            );

            res.json({
                status: 'sucesso',
                mensagem: 'Imagem enviada com sucesso.',
                data: {
                    message_id: response.key.id,
                    to: numero,
                    timestamp: new Date().toISOString()
                }
            });
        } catch (error) {
            console.error('[MESSAGES] Erro ao enviar imagem:', error);

            if (error.message === 'Number not found on WhatsApp') {
                return res.status(404).json({
                    status: 'erro',
                    mensagem: 'Número não encontrado no WhatsApp.'
                });
            }

            res.status(500).json({
                status: 'erro',
                mensagem: 'Falha ao enviar imagem',
                detalhe: error.message
            });
        }
    }
);

/**
 * POST /api/v1/sessions/:session_id/send-bulk
 * Envia mensagem para múltiplos números (broadcast)
 */
router.post('/:session_id/send-bulk',
    authorizeSession,
    async (req, res) => {
        try {
            const sessionId = req.params.session_id;
            const { numeros, mensagem } = req.body;

            // Validações
            if (!numeros || !Array.isArray(numeros) || numeros.length === 0 || !mensagem) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Missing required fields: numeros (array), mensagem'
                });
            }

            // Limitar broadcast
            const maxBulk = 50;
            if (numeros.length > maxBulk) {
                return res.status(400).json({
                    status: 'error',
                    message: `Bulk limit exceeded. Maximum ${maxBulk} numbers per request.`
                });
            }

            // Verificar sessão
            const socket = sessionManager.getSession(sessionId);
            if (!socket || !socket.user) {
                return res.status(503).json({
                    status: 'error',
                    message: 'Session not connected'
                });
            }

            // Validar números
            const { valid, invalid } = whatsappService.validarListaNumeros(numeros);

            // Sanitizar mensagem
            const mensagemSanitizada = whatsappService.sanitizarTexto(mensagem);

            // Enviar para números válidos
            const results = [];
            for (const numero of valid) {
                try {
                    const response = await sessionManager.sendMessage(
                        sessionId,
                        numero,
                        mensagemSanitizada
                    );

                    results.push({
                        numero,
                        status: 'success',
                        message_id: response.key.id
                    });

                    // Delay entre envios para evitar ban
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    results.push({
                        numero,
                        status: 'error',
                        error: error.message
                    });
                }
            }

            res.json({
                status: 'success',
                message: 'Bulk send completed',
                data: {
                    total: numeros.length,
                    sent: results.filter(r => r.status === 'success').length,
                    failed: results.filter(r => r.status === 'error').length,
                    invalid: invalid.length,
                    results,
                    invalid_numbers: invalid
                }
            });
        } catch (error) {
            console.error('[MESSAGES] Erro em bulk send:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to send bulk messages',
                detail: error.message
            });
        }
    }
);

module.exports = router;

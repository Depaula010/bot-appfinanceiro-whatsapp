// ========================================
// Session Manager - Orquestrador Multi-Sessão
// ========================================
// Gerencia múltiplas sessões WhatsApp simultaneamente

const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    DisconnectReason,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const { createAuthState, removeAuthState } = require('../models/authState');
const Session = require('../models/session');
const { pool } = require('../config/database');
const { generateWebhookSignature } = require('../utils/crypto');
const { formatarChatId, extrairNumero, isBroadcast } = require('../utils/formatting');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

class SessionManager {
    constructor() {
        this.activeSessions = new Map(); // sessionId -> WASocket
        this.qrCodeCache = new Map(); // sessionId -> {qr, expiresAt}
        this.reconnectAttempts = new Map(); // sessionId -> attemptCount
        this.maxConcurrentSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '50', 10);
    }

    /**
     * Cria e inicia uma nova sessão WhatsApp
     * @param {string} sessionId - UUID da sessão
     * @returns {Promise<Object>} Socket WhatsApp criado
     */
    async createSession(sessionId) {
        // Verificar limite de sessões concorrentes
        if (this.activeSessions.size >= this.maxConcurrentSessions) {
            throw new Error(`Maximum concurrent sessions limit reached: ${this.maxConcurrentSessions}`);
        }

        // Verificar se sessão já está ativa
        if (this.activeSessions.has(sessionId)) {
            logger.warn({ sessionId }, 'Sessão já está ativa');
            return this.activeSessions.get(sessionId);
        }

        // Buscar configuração da sessão
        const sessionConfig = await Session.findById(sessionId);
        if (!sessionConfig) {
            throw new Error('Session not found in database');
        }

        logger.info({ sessionId, sessionName: sessionConfig.session_name }, 'Criando nova sessão WhatsApp');

        try {
            // Criar auth state
            const { state, saveCreds, loadCreds } = await createAuthState(sessionId);
            await loadCreds();

            // Buscar versão do Baileys
            const { version } = await fetchLatestBaileysVersion();

            // Criar socket WhatsApp
            const sock = makeWASocket({
                version,
                logger: pino({ level: 'warn' }),
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: state.keys
                },
                browser: ['WhatsApp Bot API', 'Chrome', '1.0.0'],
                getMessage: async () => ({ conversation: '' })
            });

            // Event handlers
            sock.ev.on('connection.update', async (update) => {
                await this.handleConnectionUpdate(sessionId, update, sessionConfig);
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('messages.upsert', async (m) => {
                await this.handleIncomingMessage(sessionId, m, sessionConfig);
            });

            // Armazenar sessão ativa
            this.activeSessions.set(sessionId, sock);

            // Atualizar status no banco
            await Session.updateStatus(sessionId, 'connecting');

            // Log de criação
            await this.logEvent(sessionId, 'session_created', {
                session_name: sessionConfig.session_name
            });

            logger.info({ sessionId }, 'Sessão WhatsApp criada com sucesso');

            return sock;
        } catch (error) {
            logger.error({ err: error, sessionId }, 'Erro ao criar sessão');
            await Session.updateStatus(sessionId, 'failed');
            await this.logEvent(sessionId, 'session_error', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Handler para atualizações de conexão
     */
    async handleConnectionUpdate(sessionId, update, config) {
        const { connection, lastDisconnect, qr } = update;

        try {
            // QR Code gerado
            if (qr) {
                logger.info({ sessionId }, 'QR Code gerado');

                const expiresAt = new Date(Date.now() + 60000); // 1 minuto

                // Armazenar QR no cache
                this.qrCodeCache.set(sessionId, { qr, expiresAt });

                // Salvar QR no banco
                await Session.updateQR(sessionId, qr, expiresAt);

                // Log
                await this.logEvent(sessionId, 'qr_generated', {
                    expires_at: expiresAt.toISOString()
                });
            }

            // Conexão aberta
            if (connection === 'open') {
                const sock = this.activeSessions.get(sessionId);

                if (sock && sock.user) {
                    const phoneNumber = sock.user.id.split(':')[0];

                    logger.info({ sessionId, phoneNumber }, 'Sessão conectada com sucesso');

                    // Atualizar status no banco
                    await Session.update(sessionId, {
                        status: 'connected',
                        phone_number: phoneNumber,
                        last_connected_at: new Date(),
                        qr_code: null,
                        qr_expires_at: null
                    });

                    // Limpar QR do cache
                    this.qrCodeCache.delete(sessionId);

                    // Resetar contador de reconexão
                    this.reconnectAttempts.delete(sessionId);

                    // Log
                    await this.logEvent(sessionId, 'connected', {
                        phone_number: phoneNumber
                    });

                    // Notificar webhook (opcional)
                    await this.notifyWebhook(sessionId, 'connected', config, {
                        phone_number: phoneNumber
                    });
                }
            }

            // Conexão fechada
            if (connection === 'close') {
                logger.warn({ sessionId, lastDisconnect }, 'Conexão fechada');

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    // Incrementar tentativas
                    const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
                    this.reconnectAttempts.set(sessionId, attempts);

                    const maxAttempts = 5;
                    const delay = Math.min(attempts * 5000, 30000); // Max 30s

                    if (attempts <= maxAttempts) {
                        logger.info({ sessionId, attempts, delay }, 'Tentando reconectar...');

                        await Session.updateStatus(sessionId, 'connecting');

                        setTimeout(() => {
                            this.createSession(sessionId).catch(err => {
                                logger.error({ err, sessionId }, 'Erro na reconexão');
                            });
                        }, delay);
                    } else {
                        logger.error({ sessionId }, 'Máximo de tentativas de reconexão atingido');
                        await Session.updateStatus(sessionId, 'failed');
                        this.activeSessions.delete(sessionId);
                        this.reconnectAttempts.delete(sessionId);
                    }
                } else {
                    // Logout - limpar tudo
                    logger.info({ sessionId }, 'Sessão deslogada (logout)');

                    await Session.updateStatus(sessionId, 'disconnected');
                    await removeAuthState(sessionId);

                    this.activeSessions.delete(sessionId);
                    this.qrCodeCache.delete(sessionId);
                    this.reconnectAttempts.delete(sessionId);

                    await this.logEvent(sessionId, 'disconnected', {
                        reason: 'logged_out'
                    });

                    await this.notifyWebhook(sessionId, 'disconnected', config, {
                        reason: 'logged_out'
                    });
                }
            }
        } catch (error) {
            logger.error({ err: error, sessionId }, 'Erro no handler de conexão');
        }
    }

    /**
     * Handler para mensagens recebidas
     */
    async handleIncomingMessage(sessionId, m, config) {
        if (!m.messages || m.messages.length === 0) return;

        const msg = m.messages[0];

        // Filtros
        if (!msg.message || msg.key.fromMe || isBroadcast(msg.key.remoteJid)) {
            return;
        }

        try {
            const msgBody = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                '';

            if (!msgBody.trim()) return;

            const fromNumber = extrairNumero(jidNormalizedUser(msg.key.remoteJid));

            logger.debug({ sessionId, from: fromNumber }, 'Mensagem recebida');

            // Marcar como lida
            const sock = this.activeSessions.get(sessionId);
            if (sock) {
                await sock.readMessages([msg.key]);
            }

            // Preparar payload para webhook
            const payload = {
                session_id: sessionId,
                texto: msgBody,
                numero_remetente: fromNumber,
                timestamp: new Date().toISOString(),
                message_id: msg.key.id
            };

            // Gerar assinatura HMAC
            const signature = generateWebhookSignature(payload, config.webhook_signature_key);

            // Enviar para webhook
            const response = await axios.post(config.webhook_url, payload, {
                headers: {
                    'X-Webhook-Signature': signature,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            logger.debug({ sessionId, statusCode: response.status }, 'Webhook enviado com sucesso');

            // Reagir com ✓
            if (sock) {
                await sock.sendMessage(msg.key.remoteJid, {
                    react: { text: '✓', key: msg.key }
                });
            }

            // Log
            await this.logEvent(sessionId, 'message_received', {
                from: fromNumber,
                message_id: msg.key.id
            });

        } catch (error) {
            logger.error({ err: error, sessionId }, 'Erro ao processar mensagem recebida');

            // Reagir com ❌
            const sock = this.activeSessions.get(sessionId);
            if (sock && msg.key) {
                await sock.sendMessage(msg.key.remoteJid, {
                    react: { text: '❌', key: msg.key }
                }).catch(() => {});
            }

            // Log erro
            await this.logEvent(sessionId, 'webhook_error', {
                error: error.message,
                webhook_url: config.webhook_url
            });
        }
    }

    /**
     * Envia mensagem de texto
     */
    async sendMessage(sessionId, numero, mensagem) {
        const sock = this.activeSessions.get(sessionId);

        if (!sock || !sock.user) {
            throw new Error('Session not connected');
        }

        const chatId = formatarChatId(numero);

        // Verificar se número existe no WhatsApp
        const [result] = await sock.onWhatsApp(chatId);
        if (!result?.exists) {
            throw new Error('Number not found on WhatsApp');
        }

        // Enviar mensagem
        const response = await sock.sendMessage(chatId, { text: mensagem });

        // Log
        await this.logEvent(sessionId, 'message_sent', {
            to: numero,
            message_id: response.key.id
        });

        return response;
    }

    /**
     * Envia imagem
     */
    async sendImage(sessionId, numero, imageBuffer, caption = '') {
        const sock = this.activeSessions.get(sessionId);

        if (!sock || !sock.user) {
            throw new Error('Session not connected');
        }

        const chatId = formatarChatId(numero);

        const [result] = await sock.onWhatsApp(chatId);
        if (!result?.exists) {
            throw new Error('Number not found on WhatsApp');
        }

        const response = await sock.sendMessage(chatId, {
            image: imageBuffer,
            caption: caption
        });

        await this.logEvent(sessionId, 'image_sent', {
            to: numero,
            message_id: response.key.id
        });

        return response;
    }

    /**
     * Desconecta uma sessão
     */
    async disconnectSession(sessionId) {
        const sock = this.activeSessions.get(sessionId);

        if (sock) {
            logger.info({ sessionId }, 'Desconectando sessão');

            await sock.logout();
            this.activeSessions.delete(sessionId);
            this.qrCodeCache.delete(sessionId);
            this.reconnectAttempts.delete(sessionId);
        }

        await Session.updateStatus(sessionId, 'disconnected');
        await this.logEvent(sessionId, 'disconnected', { manual: true });
    }

    /**
     * Obtém sessão ativa
     */
    getSession(sessionId) {
        return this.activeSessions.get(sessionId);
    }

    /**
     * Obtém QR code do cache
     */
    getQRCode(sessionId) {
        return this.qrCodeCache.get(sessionId);
    }

    /**
     * Notifica webhook de evento
     */
    async notifyWebhook(sessionId, eventType, config, data = {}) {
        try {
            const payload = {
                event: eventType,
                session_id: sessionId,
                timestamp: new Date().toISOString(),
                ...data
            };

            const signature = generateWebhookSignature(payload, config.webhook_signature_key);

            await axios.post(config.webhook_url, payload, {
                headers: {
                    'X-Webhook-Signature': signature,
                    'X-Event-Type': eventType,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
        } catch (error) {
            logger.warn({ err: error, sessionId, eventType }, 'Falha ao notificar webhook');
        }
    }

    /**
     * Registra evento no log
     */
    async logEvent(sessionId, eventType, details = {}) {
        try {
            await pool.query(
                `INSERT INTO session_logs (session_id, event_type, details)
                 VALUES ($1, $2, $3)`,
                [sessionId, eventType, JSON.stringify(details)]
            );
        } catch (error) {
            logger.error({ err: error, sessionId, eventType }, 'Erro ao registrar log');
        }
    }

    /**
     * Retorna estatísticas do gerenciador
     */
    getStats() {
        return {
            active_sessions: this.activeSessions.size,
            pending_qr: this.qrCodeCache.size,
            reconnecting: this.reconnectAttempts.size,
            max_concurrent: this.maxConcurrentSessions
        };
    }
}

// Singleton
module.exports = new SessionManager();

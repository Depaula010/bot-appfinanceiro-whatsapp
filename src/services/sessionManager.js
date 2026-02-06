// ========================================
// Session Manager - Orquestrador Multi-Sessão (CORRIGIDO)
// ========================================

const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    DisconnectReason,
    jidNormalizedUser,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const qrcode = require('qrcode-terminal'); // <--- IMPORTANTE: Garanta que instalou (npm install qrcode-terminal)
const { createAuthState, removeAuthState } = require('../models/authState');
const Session = require('../models/session');
const { pool } = require('../config/database');
const { generateWebhookSignature } = require('../utils/crypto');
const { formatarChatId, extrairNumero, isBroadcast } = require('../utils/formatting');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

class SessionManager {
    constructor() {
        this.activeSessions = new Map();
        this.qrCodeCache = new Map();
        this.reconnectAttempts = new Map();
        this.maxConcurrentSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '50', 10);
    }

    async createSession(sessionId) {
        if (this.activeSessions.size >= this.maxConcurrentSessions) {
            throw new Error(`Maximum concurrent sessions limit reached: ${this.maxConcurrentSessions}`);
        }

        // Se a sessão já existe na memória, retorna ela (evita duplicação)
        if (this.activeSessions.has(sessionId)) {
            logger.warn({ sessionId }, 'Sessão já está ativa');
            return this.activeSessions.get(sessionId);
        }

        const sessionConfig = await Session.findById(sessionId);
        if (!sessionConfig) {
            throw new Error('Session not found in database');
        }

        logger.info({ sessionId, sessionName: sessionConfig.session_name }, 'Criando nova sessão WhatsApp');

        try {
            const { state, saveCreds, loadCreds, clearCreds } = await createAuthState(sessionId);

            // Tentar carregar credenciais existentes
            try {
                await loadCreds();
                console.log(`[${sessionConfig.session_name}] Credenciais carregadas do banco`);
            } catch (loadError) {
                // Se falhar ao carregar (credenciais corrompidas do formato antigo), limpar tudo
                console.error(`[${sessionConfig.session_name}] ⚠️  Erro ao carregar credenciais antigas:`, loadError.message);
                console.log(`[${sessionConfig.session_name}] 🔄 Limpando credenciais corrompidas...`);
                await clearCreds();
                console.log(`[${sessionConfig.session_name}] ✨ Começando com credenciais novas`);
            }

            const { version } = await fetchLatestBaileysVersion();
            logger.info({ sessionId, version: version.join('.') }, 'Versão do Baileys obtida');

            // Cache de retentativa de mensagens (Vital para evitar erro 515 na decifragem)
            const msgRetryCounterCache = new Map();

            const sock = makeWASocket({
                version,
                logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' }),
                printQRInTerminal: false, // Desligado nativo para usarmos o qrcode-terminal
                auth: {
                    creds: state.creds,
                    keys: state.keys
                },
                // Navegador mais "aceitável" para evitar desconexões
                browser: ['Ubuntu', 'Chrome', '20.0.04'],

                // === CONFIGURAÇÕES DE ESTABILIDADE ===
                msgRetryCounterCache, // Adicionado para estabilidade
                syncFullHistory: false, // Não sincroniza histórico completo (evita 515)
                markOnlineOnConnect: false, // Não marca online imediatamente
                connectTimeoutMs: 60000, // Timeout de 60s para conexão
                defaultQueryTimeoutMs: 60000, // Aumentado para 60s (evita timeout em queries lentas)
                keepAliveIntervalMs: 10000, // Keep-alive mais agressivo (10s) para manter stream ativa
                retryRequestDelayMs: 250, // Delay menor entre retries

                getMessage: async (key) => {
                    // Retorna mensagem vazia para evitar erros de "message not found"
                    return { conversation: '' };
                }
            });

            // === LISTENERS DE EVENTOS ===

            // Handler de conexão
            sock.ev.on('connection.update', async (update) => {
                await this.handleConnectionUpdate(sessionId, update, sessionConfig);
            });

            // Handler de credenciais - CRÍTICO para manter sessão
            sock.ev.on('creds.update', async () => {
                try {
                    await saveCreds();
                    logger.debug({ sessionId }, 'Credenciais atualizadas e salvas');
                } catch (error) {
                    logger.error({ err: error, sessionId }, 'ERRO ao salvar credenciais');
                }
            });

            // Handler de mensagens
            sock.ev.on('messages.upsert', async (m) => {
                await this.handleIncomingMessage(sessionId, m, sessionConfig);
            });

            // Handler de erros do WebSocket (novo)
            sock.ws.on('error', (error) => {
                logger.error({ err: error, sessionId }, 'Erro no WebSocket');
            });

            // Adiciona na memória
            this.activeSessions.set(sessionId, sock);
            await Session.updateStatus(sessionId, 'connecting');

            logger.info({ sessionId }, 'Sessão WhatsApp criada com sucesso');

            return sock;
        } catch (error) {
            logger.error({ err: error, sessionId }, 'Erro ao criar sessão');
            await Session.updateStatus(sessionId, 'failed');
            // Garante limpeza em caso de erro na criação
            this.activeSessions.delete(sessionId);
            throw error;
        }
    }

    async handleConnectionUpdate(sessionId, update, config) {
        const { connection, lastDisconnect, qr } = update;

        console.log(`[${config.session_name}] Connection update:`, { connection, hasQr: !!qr, statusCode: lastDisconnect?.error?.output?.statusCode });

        try {
            // === 1. LÓGICA DE QR CODE ===
            if (qr) {
                console.log(`[${config.session_name}] ✨ QR Code gerado!`);
                logger.info({ sessionId }, 'QR Code gerado');
                const expiresAt = new Date(Date.now() + 60000);

                this.qrCodeCache.set(sessionId, { qr, expiresAt });
                await Session.updateQR(sessionId, qr, expiresAt);

                // IMPRIMIR NO TERMINAL (FUNDAMENTAL)
                console.log('\n========================================');
                console.log('🔐 ESCANEIE O QR CODE ABAIXO:');
                console.log('Sessão: ' + config.session_name);
                qrcode.generate(qr, { small: true });
                console.log('========================================\n');

                await this.logEvent(sessionId, 'qr_generated', { expires_at: expiresAt.toISOString() });
            }

            // === 2. CONEXÃO BEM SUCEDIDA ===
            if (connection === 'open') {
                const sock = this.activeSessions.get(sessionId);
                if (sock && sock.user) {
                    const phoneNumber = sock.user.id.split(':')[0];
                    console.log(`[${config.session_name}] ✅ Sessão conectada! Telefone: ${phoneNumber}`);
                    logger.info({ sessionId, phoneNumber }, 'Sessão conectada com sucesso');

                    await Session.update(sessionId, {
                        status: 'connected',
                        phone_number: phoneNumber,
                        last_connected_at: new Date(),
                        qr_code: null,
                        qr_expires_at: null
                    });

                    this.qrCodeCache.delete(sessionId);
                    this.reconnectAttempts.delete(sessionId);

                    console.log('\n✅ *** BOT CONECTADO COM SUCESSO! ***\n');
                }
            }

            // === 3. CONEXÃO FECHADA E RECONEXÃO ===
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                // === TRATAMENTO ESPECIAL PARA ERRO 515 ===
                // Erro 515 indica auth corrompido - geralmente precisa limpar.
                // Mas as vezes é apenas instabilidade. Vamos tentar reconectar 3x antes de desistir.
                if (statusCode === 515) {
                    const currentAttempts = this.reconnectAttempts.get(sessionId) || 0;

                    // Só limpa se já tentou 3 vezes (0, 1, 2)
                    if (currentAttempts >= 3) {
                        logger.warn({ sessionId, attempts: currentAttempts }, 'Erro 515 persistente. Limpando credenciais...');

                        try {
                            await removeAuthState(sessionId);
                            await Session.updateStatus(sessionId, 'disconnected');
                            this.activeSessions.delete(sessionId);
                            this.qrCodeCache.delete(sessionId);
                            this.reconnectAttempts.delete(sessionId);

                            console.log('\n========================================');
                            console.log('⚠️  ERRO 515: Auth corrompido detectado (após ' + currentAttempts + ' tentativas)!');
                            console.log('🔄 Credenciais limpas. Reiniciando sessão...');
                            console.log('📱 Um novo QR Code será gerado.');
                            console.log('========================================\n');

                            // Delay mais longo para garantir limpeza completa
                            setTimeout(() => {
                                this.createSession(sessionId).catch(err => {
                                    logger.error({ err, sessionId }, 'Erro ao recriar sessão após 515');
                                });
                            }, 3000);
                        } catch (cleanupError) {
                            logger.error({ err: cleanupError, sessionId }, 'Erro ao limpar auth após 515');
                            await Session.updateStatus(sessionId, 'failed');
                        }
                        return;
                    } else {
                        console.log(`[${config.session_name}] ⚠️ Erro 515 detectado (Tentativa ${currentAttempts + 1}/3). Tentando reconexão simples...`);
                        logger.warn({ sessionId, attempt: currentAttempts + 1 }, 'Erro 515 - Tentando reconexão antes de limpar credenciais');
                        // Deixa cair no fluxo normal de reconexão abaixo (que incrementa o contador)
                    }
                }
                // ============================================

                // Se caiu mas pode voltar (Ex: Timeout de QR Code ou Queda de Net)
                if (shouldReconnect) {
                    const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
                    this.reconnectAttempts.set(sessionId, attempts);
                    const delay = Math.min(attempts * 5000, 30000); // Max 30s

                    if (attempts <= 10) { // Aumentei um pouco as tentativas
                        logger.info({ sessionId, attempts }, `Conexão caiu (${statusCode}). Tentando reconectar em ${delay}ms...`);

                        // === CORREÇÃO CRÍTICA AQUI ===
                        // Removemos a sessão antiga da memória para permitir que o createSession crie uma nova
                        this.activeSessions.delete(sessionId);
                        // ==============================

                        setTimeout(() => {
                            this.createSession(sessionId).catch(err => logger.error({ err }, 'Erro fatal na reconexão'));
                        }, delay);
                    } else {
                        logger.error({ sessionId }, 'Muitas tentativas falhas. Desistindo.');
                        await Session.updateStatus(sessionId, 'failed');
                        this.activeSessions.delete(sessionId);
                    }
                } else {
                    // Logout definitivo
                    logger.info({ sessionId }, 'Sessão desconectada (Logout/Ban/Desistência)');
                    await Session.updateStatus(sessionId, 'disconnected');
                    await removeAuthState(sessionId);
                    this.activeSessions.delete(sessionId);
                    this.qrCodeCache.delete(sessionId);
                }
            }
        } catch (error) {
            logger.error({ err: error, sessionId }, 'Erro no handler de conexão');
        }
    }

    async handleIncomingMessage(sessionId, m, config) {
        if (!m.messages || m.messages.length === 0) return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || isBroadcast(msg.key.remoteJid)) return;

        try {
            // Extrair texto da mensagem (suporte a diversos formatos)
            const conversation = msg.message.conversation;
            const extendedText = msg.message.extendedTextMessage?.text;

            // === SUPORTE A MÍDIA (Google Drive Upload) ===
            const imageMessage = msg.message.imageMessage;
            const documentMessage = msg.message.documentMessage;
            const audioMessage = msg.message.audioMessage;

            // Caption pode vir de imagem ou documento
            const mediaCaption = imageMessage?.caption || documentMessage?.caption;

            const texto = conversation || extendedText || mediaCaption;

            if (!texto) return; // Ignora mensagens sem texto (ex: sticker sem legenda)

            const remoteJid = msg.key.remoteJid;
            // Apenas mensagens privadas por enquanto
            if (remoteJid.includes('@g.us')) return;

            logger.info({ sessionId, from: remoteJid }, `Mensagem recebida: ${texto}`);

            // === PROCESSAR MÍDIA PARA UPLOAD ===
            const hasMedia = imageMessage || documentMessage || audioMessage;
            let mediaPayload = {};

            if (hasMedia) {
                try {
                    logger.info({ sessionId, mimeType: hasMedia.mimetype }, 'Baixando mídia...');
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});

                    mediaPayload = {
                        media_data: buffer.toString('base64'),
                        media_type: hasMedia.mimetype,
                        media_filename: hasMedia.fileName || `arquivo_${Date.now()}`
                    };

                    logger.info({ sessionId, type: hasMedia.mimetype, size: buffer.length }, 'Mídia capturada com sucesso');
                } catch (mediaErr) {
                    logger.warn({ err: mediaErr.message, sessionId }, 'Falha ao baixar mídia - continuando sem anexo');
                }
            }

            // Preparar payload (com ou sem mídia)
            const payload = {
                texto: texto,
                numero_remetente: remoteJid,
                ...mediaPayload
            };

            // Gerar assinatura HMAC (Segurança)
            // === SAAS / MULTI-TENANCY SUPPORT ===
            // A URL do webhook deve vir ESTRITAMENTE da configuração da sessão no banco.
            // Sem fallback para variáveis de ambiente globais.
            const webhookUrl = config.webhook_url;

            if (!webhookUrl) {
                logger.warn({ sessionId }, 'Webhook URL não configurada na sessão. Ignorando mensagem.');
                return;
            }

            // === AUTENTICAÇÃO DINÂMICA ===
            // 1. Tenta pegar o token nos metadados da sessão
            // 2. Fallback para a chave global do .env
            const apiKey = config.metadata?.webhook_auth_token || process.env.API_SECRET_KEY;

            // Chave HMAC específica da sessão (ou global)
            const signatureKey = config.webhook_signature_key || process.env.WEBHOOK_SIGNATURE_KEY;

            logger.debug({
                sessionId,
                url: webhookUrl,
                usingSessionConfig: !!config.webhook_url
            }, 'Enviando webhook...');

            // Preparar headers dinâmicos
            let headers = {
                'Content-Type': 'application/json'
            };

            if (apiKey) {
                headers['x-api-key'] = apiKey;
            }

            // IMPORTANTE: Serializar o payload ANTES de assinar
            // O backend valida o HMAC dos bytes recebidos, então precisamos garantir
            // que assinamos EXATAMENTE a mesma string que enviamos.
            const payloadString = JSON.stringify(payload);

            if (signatureKey) {
                // Assinamos a STRING, não o objeto
                const signature = generateWebhookSignature(payloadString, signatureKey);
                headers['X-Webhook-Signature'] = signature;
            }

            // Enviar a STRING serializada (não o objeto) para garantir consistência
            const response = await axios.post(webhookUrl, payloadString, { headers });

            // Processar resposta do Backend
            if (response.data && response.data.resposta) {
                const respostaTexto = response.data.resposta;
                logger.info({ sessionId, to: remoteJid }, `Enviando resposta: ${respostaTexto}`);

                const sock = this.activeSessions.get(sessionId);
                if (sock) {
                    await sock.sendMessage(remoteJid, { text: respostaTexto });
                }
            }

        } catch (e) {
            logger.error({ err: e.message, sessionId }, 'Erro ao processar mensagem recebida');
            // Opcional: Avisar usuário se for erro de conexão com backend? 
            // Melhor não para não spamar, apenas logar.
        }
    }

    async sendMessage(sessionId, numero, mensagem) {
        const sock = this.activeSessions.get(sessionId);
        if (!sock) throw new Error('Session not connected');
        const chatId = formatarChatId(numero);
        return await sock.sendMessage(chatId, { text: mensagem });
    }

    getSession(sessionId) { return this.activeSessions.get(sessionId); }
    getQRCode(sessionId) { return this.qrCodeCache.get(sessionId); }
    getStats() { return { active_sessions: this.activeSessions.size }; }

    async disconnectSession(sessionId, shouldUpdateDb = true) {
        const sock = this.activeSessions.get(sessionId);
        if (sock) {
            // Fecha o socket
            sock.end(undefined);
            this.activeSessions.delete(sessionId);
        }

        if (shouldUpdateDb) {
            await Session.updateStatus(sessionId, 'disconnected');
        }
    }

    async logEvent(sessionId, eventType, details = {}) {
        // Implementação simplificada do log
        try {
            await pool.query(
                `INSERT INTO session_logs (session_id, event_type, details) VALUES ($1, $2, $3)`,
                [sessionId, eventType, JSON.stringify(details)]
            );
        } catch (error) {
            logger.error({ err: error }, 'Erro ao registrar log');
        }
    }
}

module.exports = new SessionManager();
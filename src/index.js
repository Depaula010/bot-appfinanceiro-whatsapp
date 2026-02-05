// ========================================
// WhatsApp Bot API - Multi-Session
// ========================================
// Entry point da aplicação refatorada

const express = require('express');
const helmet = require('helmet');
const pino = require('pino');
const { testConnection, pool } = require('./config/database');
const sessionManager = require('./services/sessionManager');
const Session = require('./models/session');
const { createGlobalRateLimiter } = require('./middleware/rateLimiter');

// Configurações
const app = express();
const port = process.env.PORT || 3000;
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// Trust proxy (necessário atrás de Docker/nginx para req.ip correto)
app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '1', 10));

// ========================================
// MIDDLEWARES GLOBAIS
// ========================================

// Security headers
app.use(helmet());

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Rate limiting global
app.use(createGlobalRateLimiter());

// Logger de requisições (debug apenas)
if (process.env.LOG_LEVEL === 'debug') {
    app.use((req, res, next) => {
        logger.debug({
            method: req.method,
            url: req.url,
            ip: req.ip
        }, 'Incoming request');
        next();
    });
}

// CORS (se necessário)
if (process.env.ENABLE_CORS === 'true') {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        }
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, X-Admin-Key');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');

        if (req.method === 'OPTIONS') {
            return res.sendStatus(200);
        }

        next();
    });
}

// ========================================
// ROUTES - Nova API (v1)
// ========================================

const sessionRoutes = require('./routes/sessionRoutes');
const messageRoutes = require('./routes/messageRoutes');
const adminRoutes = require('./routes/adminRoutes');

app.use('/api/v1/sessions', sessionRoutes);
app.use('/api/v1/sessions', messageRoutes); // Mensagens são subrotas de sessions
app.use('/api/v1/admin', adminRoutes);

// ========================================
// HEALTH CHECK & STATUS
// ========================================

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
    try {
        const dbHealthy = await testConnection();
        const stats = sessionManager.getStats();

        res.json({
            status: dbHealthy ? 'healthy' : 'degraded',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            active_sessions: stats.active_sessions,
            max_sessions: stats.max_concurrent,
            database: dbHealthy ? 'connected' : 'disconnected',
            version: require('../package.json').version
        });
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy'
        });
    }
});

/**
 * GET /status
 * Status geral do sistema (alias de /health)
 */
app.get('/status', async (req, res) => {
    const stats = sessionManager.getStats();

    res.json({
        status: 'running',
        active_sessions: stats.active_sessions,
        max_concurrent_sessions: stats.max_concurrent,
        uptime: process.uptime()
    });
});

// ========================================
// BACKWARD COMPATIBILITY - Endpoints Legados
// ========================================

const { validateLegacyApiKey } = require('./middleware/authMiddleware');

/**
 * POST /enviar-mensagem (LEGACY)
 * Endpoint de compatibilidade - redireciona para primeira sessão
 */
app.post('/enviar-mensagem', validateLegacyApiKey, async (req, res) => {
    try {
        // Avisos de deprecação
        res.setHeader('X-Deprecation-Warning', 'This endpoint is deprecated. Use /api/v1/sessions/:id/send-message instead');
        res.setHeader('X-Deprecation-Link', 'https://docs.example.com/migration-guide');

        const { numero, mensagem } = req.body;

        if (!numero || !mensagem) {
            return res.status(400).json({
                status: 'erro',
                mensagem: "Parâmetros 'numero' e 'mensagem' são obrigatórios"
            });
        }

        // Buscar primeira sessão ativa do sistema legado
        const result = await pool.query(`
            SELECT s.id
            FROM sessions s
            JOIN api_keys ak ON s.api_key_id = ak.id
            WHERE ak.project_name = 'Sistema Legado'
            AND s.status = 'connected'
            LIMIT 1
        `);

        if (result.rows.length === 0) {
            return res.status(503).json({
                status: 'erro',
                mensagem: 'Bot não está pronto. Aguarde a conexão.'
            });
        }

        const sessionId = result.rows[0].id;

        // Enviar mensagem
        const response = await sessionManager.sendMessage(sessionId, numero, mensagem);

        res.json({
            status: 'sucesso',
            mensagem: 'Mensagem enviada com sucesso.'
        });
    } catch (error) {
        logger.error({ err: error }, 'Erro em endpoint legado /enviar-mensagem');

        if (error.message === 'Number not found on WhatsApp') {
            return res.status(404).json({
                status: 'erro',
                mensagem: 'Número não encontrado no WhatsApp.'
            });
        }

        res.status(500).json({
            status: 'erro',
            mensagem: 'Falha ao enviar mensagem'
        });
    }
});

/**
 * POST /enviar-imagem (LEGACY)
 */
app.post('/enviar-imagem', validateLegacyApiKey, async (req, res) => {
    try {
        res.setHeader('X-Deprecation-Warning', 'This endpoint is deprecated. Use /api/v1/sessions/:id/send-image instead');

        const { numero, imagem, legenda } = req.body;

        if (!numero || !imagem) {
            return res.status(400).json({
                status: 'erro',
                mensagem: "Parâmetros 'numero' e 'imagem' são obrigatórios"
            });
        }

        const result = await pool.query(`
            SELECT s.id
            FROM sessions s
            JOIN api_keys ak ON s.api_key_id = ak.id
            WHERE ak.project_name = 'Sistema Legado'
            AND s.status = 'connected'
            LIMIT 1
        `);

        if (result.rows.length === 0) {
            return res.status(503).json({
                status: 'erro',
                mensagem: 'Bot não está pronto'
            });
        }

        const sessionId = result.rows[0].id;

        const whatsappService = require('./services/whatsappService');
        const imageBuffer = whatsappService.base64ToBuffer(imagem);

        await sessionManager.sendImage(sessionId, numero, imageBuffer, legenda || '');

        res.json({
            status: 'sucesso',
            mensagem: 'Imagem enviada com sucesso.'
        });
    } catch (error) {
        logger.error({ err: error }, 'Erro em endpoint legado /enviar-imagem');
        res.status(500).json({
            status: 'erro',
            mensagem: 'Falha ao enviar imagem'
        });
    }
});

/**
 * GET /ping (LEGACY)
 * Endpoint de ping - mantido sem mudanças
 */
let ultimoDiaExecutado = null;

app.get('/ping', validateLegacyApiKey, async (req, res) => {
    try {
        const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

        // Cron job diário às 8h
        if (ultimoDiaExecutado !== hoje) {
            const agora = new Date();
            const horaAtual = agora.getHours();

            if (horaAtual === 8) {
                logger.info('Executando cron job diário às 8h');

                const pythonApiUrl = process.env.PYTHON_API_URL || 'http://localhost:8000';
                const axios = require('axios');

                try {
                    await axios.post(`${pythonApiUrl}/admin/run-motor-agendamentos`, {}, {
                        headers: { 'X-API-Key': process.env.API_SECRET_KEY },
                        timeout: 30000
                    });

                    logger.info('Cron job executado com sucesso');
                } catch (error) {
                    logger.error({ err: error }, 'Erro no cron job');
                }

                ultimoDiaExecutado = hoje;
            }
        }

        // Status da primeira sessão legada
        const result = await pool.query(`
            SELECT s.status, s.phone_number
            FROM sessions s
            JOIN api_keys ak ON s.api_key_id = ak.id
            WHERE ak.project_name = 'Sistema Legado'
            LIMIT 1
        `);

        const isConnected = result.rows.length > 0 && result.rows[0].status === 'connected';

        res.json({
            pong: true,
            bot_conectado: isConnected,
            numero: result.rows[0]?.phone_number || null,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error({ err: error }, 'Erro em /ping');
        res.status(500).json({ pong: false });
    }
});

/**
 * POST /limpar-sessao (LEGACY)
 */
app.post('/limpar-sessao', validateLegacyApiKey, async (req, res) => {
    try {
        res.setHeader('X-Deprecation-Warning', 'This endpoint is deprecated. Use /api/v1/sessions/:id/disconnect instead');

        const result = await pool.query(`
            SELECT s.id
            FROM sessions s
            JOIN api_keys ak ON s.api_key_id = ak.id
            WHERE ak.project_name = 'Sistema Legado'
            LIMIT 1
        `);

        if (result.rows.length > 0) {
            await sessionManager.disconnectSession(result.rows[0].id);
        }

        res.json({
            status: 'sucesso',
            mensagem: 'Sessão limpa com sucesso'
        });
    } catch (error) {
        logger.error({ err: error }, 'Erro ao limpar sessão');
        res.status(500).json({
            status: 'erro',
            mensagem: 'Erro ao limpar sessão'
        });
    }
});

// ========================================
// ERROR HANDLERS
// ========================================

// 404 - Route not found
app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Endpoint not found',
        path: req.path
    });
});

// Global error handler
app.use((err, req, res, next) => {
    logger.error({ err }, 'Unhandled error');

    res.status(err.status || 500).json({
        status: 'error',
        message: 'Internal server error'
    });
});

// ========================================
// STARTUP
// ========================================

async function startServer() {
    try {
        logger.info('🚀 Iniciando WhatsApp Bot API (Multi-Session)...');

        // Testar conexão com banco
        logger.info('📡 Testando conexão com PostgreSQL...');
        const dbConnected = await testConnection();

        if (!dbConnected) {
            throw new Error('Falha ao conectar com PostgreSQL');
        }

        // Restaurar sessões ativas
        logger.info('🔄 Restaurando sessões ativas...');
        const activeSessions = await Session.findAll({ status: 'connected' });

        logger.info(`Encontradas ${activeSessions.length} sessões para restaurar`);

        for (const session of activeSessions) {
            try {
                await sessionManager.createSession(session.id);
                logger.info({ sessionId: session.id }, 'Sessão restaurada');
            } catch (error) {
                logger.error({ err: error, sessionId: session.id }, 'Erro ao restaurar sessão');
            }
        }

        // Iniciar servidor
        app.listen(port, () => {
            logger.info(`✅ Servidor rodando na porta ${port}`);
            logger.info(`📚 Documentação: http://localhost:${port}/api/v1/docs`);
            logger.info(`❤️  Health check: http://localhost:${port}/health`);
            logger.info('\n🎉 WhatsApp Bot API pronto para uso!\n');
        });
    } catch (error) {
        logger.error({ err: error }, '❌ Falha ao iniciar servidor');
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('Recebido SIGTERM, encerrando gracefully...');

    // Desconectar todas as sessões
    const sessions = Array.from(sessionManager.activeSessions.keys());
    for (const sessionId of sessions) {
        await sessionManager.disconnectSession(sessionId);
    }

    // Fechar pool
    await pool.end();

    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('Recebido SIGINT, encerrando...');
    process.exit(0);
});

// Iniciar se for módulo principal
if (require.main === module) {
    startServer();
}

module.exports = app;

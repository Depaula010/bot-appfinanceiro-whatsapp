// ========================================
// Middleware de Autenticação e Autorização
// ========================================
// Validação de API keys e autorização de sessões

const crypto = require('crypto');
const pino = require('pino');
const ApiKey = require('../models/apiKey');
const Session = require('../models/session');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

/**
 * Middleware para validar API key no header X-API-Key
 * Anexa req.apiKey com os dados da key validada
 */
async function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({
            status: 'error',
            message: 'Missing X-API-Key header'
        });
    }

    try {
        const keyRecord = await ApiKey.validate(apiKey);

        if (!keyRecord) {
            return res.status(401).json({
                status: 'error',
                message: 'Invalid or expired API key'
            });
        }

        // Anexar dados da API key ao request
        req.apiKey = keyRecord;
        req.apiKeyId = keyRecord.id;

        next();
    } catch (error) {
        logger.error({ err: error }, 'Erro ao validar API key');
        return res.status(500).json({
            status: 'error',
            message: 'Internal server error during authentication'
        });
    }
}

/**
 * Middleware para validar que uma sessão pertence à API key autenticada
 * Requer validateApiKey executado antes
 * Anexa req.session com os dados da sessão validada
 */
async function authorizeSession(req, res, next) {
    const sessionId = req.params.session_id;

    if (!sessionId) {
        return res.status(400).json({
            status: 'error',
            message: 'Missing session_id parameter'
        });
    }

    if (!req.apiKeyId) {
        return res.status(401).json({
            status: 'error',
            message: 'Not authenticated'
        });
    }

    try {
        const session = await Session.findById(sessionId);

        if (!session) {
            return res.status(404).json({
                status: 'error',
                message: 'Session not found'
            });
        }

        // Verificar se a sessão pertence à API key
        if (session.api_key_id !== req.apiKeyId) {
            return res.status(403).json({
                status: 'error',
                message: 'Access denied to this session'
            });
        }

        // Anexar sessão ao request
        req.session = session;

        next();
    } catch (error) {
        logger.error({ err: error }, 'Erro ao autorizar sessão');
        return res.status(500).json({
            status: 'error',
            message: 'Internal server error during authorization'
        });
    }
}

/**
 * Middleware para validar chave de admin (para endpoints administrativos)
 * Valida contra ADMIN_API_KEY do ambiente
 */
function validateAdminKey(req, res, next) {
    const adminKey = req.headers['x-admin-key'];
    const expectedAdminKey = process.env.ADMIN_API_KEY;

    if (!expectedAdminKey) {
        logger.error('ADMIN_API_KEY não configurada no ambiente');
        return res.status(500).json({
            status: 'error',
            message: 'Admin endpoints not configured'
        });
    }

    if (!adminKey) {
        return res.status(401).json({
            status: 'error',
            message: 'Missing X-Admin-Key header'
        });
    }

    // Timing-safe comparison para prevenir timing attacks
    const adminBuf = Buffer.from(adminKey);
    const expectedBuf = Buffer.from(expectedAdminKey);
    if (adminBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(adminBuf, expectedBuf)) {
        logger.warn({ ip: req.ip }, 'Tentativa de acesso admin com chave inválida');
        return res.status(403).json({
            status: 'error',
            message: 'Invalid admin key'
        });
    }

    next();
}

/**
 * Middleware para verificar limite de sessões por API key
 * Requer validateApiKey executado antes
 * @param {number} maxSessions - Máximo de sessões permitidas (padrão do env)
 */
function checkSessionLimit(maxSessions = null) {
    return async (req, res, next) => {
        if (!req.apiKeyId) {
            return res.status(401).json({
                status: 'error',
                message: 'Not authenticated'
            });
        }

        const max = maxSessions || parseInt(process.env.MAX_SESSIONS_PER_API_KEY || '10', 10);

        try {
            const count = await Session.countByApiKey(req.apiKeyId);

            if (count >= max) {
                return res.status(429).json({
                    status: 'error',
                    message: `Session limit reached. Maximum ${max} sessions per API key.`,
                    current_sessions: count,
                    max_sessions: max
                });
            }

            next();
        } catch (error) {
            logger.error({ err: error }, 'Erro ao verificar limite de sessões');
            return res.status(500).json({
                status: 'error',
                message: 'Internal server error'
            });
        }
    };
}

/**
 * Middleware opcional para validar API key legada (backward compatibility)
 * Valida contra API_SECRET_KEY do ambiente
 */
function validateLegacyApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    const legacyKey = process.env.API_SECRET_KEY;

    if (!apiKey || !legacyKey) {
        return res.status(401).json({
            status: 'erro',
            mensagem: 'Não autorizado'
        });
    }

    // Timing-safe comparison para prevenir timing attacks
    const apiBuf = Buffer.from(apiKey);
    const legacyBuf = Buffer.from(legacyKey);
    if (apiBuf.length !== legacyBuf.length || !crypto.timingSafeEqual(apiBuf, legacyBuf)) {
        return res.status(401).json({
            status: 'erro',
            mensagem: 'Não autorizado'
        });
    }

    // Adicionar flag de legacy + deprecation header
    req.isLegacy = true;
    res.setHeader('X-Deprecation-Warning', 'Legacy authentication is deprecated. Migrate to API key authentication.');

    next();
}

module.exports = {
    validateApiKey,
    authorizeSession,
    validateAdminKey,
    checkSessionLimit,
    validateLegacyApiKey
};

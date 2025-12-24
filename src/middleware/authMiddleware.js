// ========================================
// Middleware de Autenticação e Autorização
// ========================================
// Validação de API keys e autorização de sessões

const ApiKey = require('../models/apiKey');
const Session = require('../models/session');

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
        console.error('[AUTH] Erro ao validar API key:', error);
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
        console.error('[AUTH] Erro ao autorizar sessão:', error);
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
        console.error('[SECURITY] ADMIN_API_KEY não configurada no ambiente');
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

    if (adminKey !== expectedAdminKey) {
        console.warn('[SECURITY] Tentativa de acesso admin com chave inválida');
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
            console.error('[AUTH] Erro ao verificar limite de sessões:', error);
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

    if (!apiKey || apiKey !== legacyKey) {
        return res.status(401).json({
            status: 'erro',
            mensagem: 'Não autorizado'
        });
    }

    // Adicionar flag de legacy
    req.isLegacy = true;

    next();
}

module.exports = {
    validateApiKey,
    authorizeSession,
    validateAdminKey,
    checkSessionLimit,
    validateLegacyApiKey
};

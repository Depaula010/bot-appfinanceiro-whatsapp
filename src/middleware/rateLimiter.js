// ========================================
// Middleware de Rate Limiting
// ========================================
// Limita requisições por API key

const rateLimit = require('express-rate-limit');

/**
 * Cria um rate limiter dinâmico baseado na API key
 * Requer middleware validateApiKey executado antes
 */
function createRateLimiter() {
    return rateLimit({
        windowMs: 60 * 1000, // 1 minuto
        max: async (req) => {
            // Usar rate limit específico da API key se disponível
            if (req.apiKey && req.apiKey.rate_limit_per_minute) {
                return req.apiKey.rate_limit_per_minute;
            }

            // Fallback para limite padrão
            return parseInt(process.env.DEFAULT_RATE_LIMIT || '60', 10);
        },
        keyGenerator: (req) => {
            // Usar ID da API key como chave para rate limiting
            if (req.apiKeyId) {
                return `api_key_${req.apiKeyId}`;
            }

            // Fallback para IP se não houver API key
            return req.ip;
        },
        message: (req) => ({
            status: 'error',
            message: 'Rate limit exceeded. Too many requests.',
            limit: req.apiKey?.rate_limit_per_minute || 60,
            window: '1 minute',
            retry_after: '60 seconds'
        }),
        standardHeaders: true, // Adiciona headers RateLimit-*
        legacyHeaders: false, // Desabilita headers X-RateLimit-*
        skip: (req) => {
            // Opcionalmente skip rate limiting para certos IPs (whitelisting)
            const whitelist = (process.env.RATE_LIMIT_WHITELIST || '').split(',');
            return whitelist.includes(req.ip);
        }
    });
}

/**
 * Rate limiter específico para endpoints de QR code
 * Limite mais generoso pois requer polling
 */
function createQRRateLimiter() {
    return rateLimit({
        windowMs: 60 * 1000, // 1 minuto
        max: 20, // Polling a cada ~3s (QR dura 60s, 20 tentativas é suficiente)
        keyGenerator: (req) => {
            const sessionId = req.params.session_id || 'unknown';
            return `qr_${req.apiKeyId || req.ip}_${sessionId}`;
        },
        message: {
            status: 'error',
            message: 'QR code polling rate limit exceeded',
            retry_after: '1 second'
        },
        standardHeaders: true,
        legacyHeaders: false
    });
}

/**
 * Rate limiter estrito para endpoints administrativos
 */
function createAdminRateLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutos
        max: 50, // Apenas 50 requisições admin a cada 15 min
        keyGenerator: (req) => req.ip,
        message: {
            status: 'error',
            message: 'Admin rate limit exceeded',
            retry_after: '15 minutes'
        },
        standardHeaders: true,
        legacyHeaders: false
    });
}

/**
 * Rate limiter para endpoints de criação de recursos
 * Previne spam de criação de sessões/keys
 */
function createCreationRateLimiter() {
    return rateLimit({
        windowMs: 60 * 1000, // 1 minuto
        max: 5, // Apenas 5 criações por minuto
        keyGenerator: (req) => {
            return `create_${req.apiKeyId || req.ip}`;
        },
        message: {
            status: 'error',
            message: 'Too many creation requests. Please slow down.',
            limit: 5,
            window: '1 minute'
        },
        standardHeaders: true,
        legacyHeaders: false
    });
}

/**
 * Rate limiter global (fallback para rotas sem limiter específico)
 */
function createGlobalRateLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutos
        max: 1000, // 1000 requisições por 15 minutos
        keyGenerator: (req) => req.ip,
        message: {
            status: 'error',
            message: 'Global rate limit exceeded'
        },
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => {
            // Skip para requisições autenticadas (usam rate limiter específico)
            return !!req.apiKeyId;
        }
    });
}

/**
 * Rate limiter para falhas de autenticação
 * Bloqueia IP após múltiplas tentativas falhas
 */
function createAuthFailureRateLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutos
        max: 5, // 5 tentativas falhas por 15 min
        keyGenerator: (req) => req.ip,
        skipSuccessfulRequests: true, // Só conta falhas (status >= 400)
        message: {
            status: 'error',
            message: 'Too many authentication failures. Try again later.',
            retry_after: '15 minutes'
        },
        standardHeaders: true,
        legacyHeaders: false
    });
}

module.exports = {
    createRateLimiter,
    createQRRateLimiter,
    createAdminRateLimiter,
    createCreationRateLimiter,
    createGlobalRateLimiter,
    createAuthFailureRateLimiter
};

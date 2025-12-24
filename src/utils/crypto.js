// ========================================
// Utilitários de Criptografia
// ========================================
// Geração de API keys, HMAC, hashing

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 10;

/**
 * Gera uma nova API key no formato whatsapp_{env}_{random}
 * @param {string} env - Ambiente (live, test, dev)
 * @returns {string} API key gerada
 */
function generateApiKey(env = 'live') {
    const randomBytes = crypto.randomBytes(32).toString('base64url');
    return `whatsapp_${env}_${randomBytes}`;
}

/**
 * Extrai o prefixo de uma API key (primeiros 16 caracteres)
 * @param {string} apiKey - API key completa
 * @returns {string} Prefixo da key
 */
function extractKeyPrefix(apiKey) {
    if (!apiKey || apiKey.length < 16) {
        throw new Error('API key inválida');
    }
    return apiKey.substring(0, 16);
}

/**
 * Hash uma API key usando bcrypt
 * @param {string} apiKey - API key em plaintext
 * @returns {Promise<string>} Hash bcrypt
 */
async function hashApiKey(apiKey) {
    return bcrypt.hash(apiKey, BCRYPT_ROUNDS);
}

/**
 * Verifica se uma API key corresponde ao hash
 * @param {string} apiKey - API key em plaintext
 * @param {string} hash - Hash bcrypt para comparar
 * @returns {Promise<boolean>} true se corresponder
 */
async function verifyApiKey(apiKey, hash) {
    return bcrypt.compare(apiKey, hash);
}

/**
 * Gera assinatura HMAC-SHA256 para webhook
 * @param {Object} payload - Objeto a ser assinado
 * @param {string} secret - Chave secreta HMAC
 * @returns {string} Assinatura em hexadecimal
 */
function generateWebhookSignature(payload, secret) {
    const payloadString = typeof payload === 'string'
        ? payload
        : JSON.stringify(payload);

    return crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');
}

/**
 * Verifica assinatura HMAC de webhook
 * @param {Object} payload - Objeto recebido
 * @param {string} signature - Assinatura fornecida
 * @param {string} secret - Chave secreta HMAC
 * @returns {boolean} true se assinatura válida
 */
function verifyWebhookSignature(payload, signature, secret) {
    const expectedSignature = generateWebhookSignature(payload, secret);
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}

/**
 * Gera um UUID v4
 * @returns {string} UUID
 */
function generateUUID() {
    return crypto.randomUUID();
}

/**
 * Gera um token aleatório (para uso geral)
 * @param {number} bytes - Número de bytes aleatórios
 * @returns {string} Token em base64url
 */
function generateRandomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Hash SHA256 de uma string
 * @param {string} data - Dados para hash
 * @returns {string} Hash em hexadecimal
 */
function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = {
    generateApiKey,
    extractKeyPrefix,
    hashApiKey,
    verifyApiKey,
    generateWebhookSignature,
    verifyWebhookSignature,
    generateUUID,
    generateRandomToken,
    sha256
};

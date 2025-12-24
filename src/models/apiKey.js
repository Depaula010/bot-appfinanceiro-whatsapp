// ========================================
// Model: API Key
// ========================================
// CRUD e operações de banco de dados para API keys

const { pool } = require('../config/database');
const { hashApiKey, verifyApiKey, extractKeyPrefix } = require('../utils/crypto');

/**
 * Cria uma nova API key
 * @param {string} apiKey - API key em plaintext (será hasheada)
 * @param {Object} data - Dados da API key
 * @param {string} data.project_name - Nome do projeto
 * @param {string} data.description - Descrição (opcional)
 * @param {number} data.rate_limit_per_minute - Rate limit (opcional, padrão 60)
 * @param {Date} data.expires_at - Data de expiração (opcional)
 * @returns {Promise<Object>} API key criada
 */
async function create(apiKey, data) {
    const { project_name, description = null, rate_limit_per_minute = 60, expires_at = null } = data;

    const keyHash = await hashApiKey(apiKey);
    const keyPrefix = extractKeyPrefix(apiKey);

    const result = await pool.query(
        `INSERT INTO api_keys (key_hash, key_prefix, project_name, description, rate_limit_per_minute, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, key_prefix, project_name, description, rate_limit_per_minute, is_active, created_at, expires_at`,
        [keyHash, keyPrefix, project_name, description, rate_limit_per_minute, expires_at]
    );

    return result.rows[0];
}

/**
 * Busca API key por ID
 * @param {string} keyId - UUID da API key
 * @returns {Promise<Object|null>} API key ou null
 */
async function findById(keyId) {
    const result = await pool.query(
        `SELECT id, key_hash, key_prefix, project_name, description, rate_limit_per_minute, is_active, last_used_at, created_at, expires_at
         FROM api_keys
         WHERE id = $1`,
        [keyId]
    );

    return result.rows[0] || null;
}

/**
 * Busca API key por prefixo
 * @param {string} keyPrefix - Prefixo da key (primeiros 16 caracteres)
 * @returns {Promise<Object|null>} API key ou null
 */
async function findByPrefix(keyPrefix) {
    const result = await pool.query(
        `SELECT * FROM api_keys WHERE key_prefix = $1 AND is_active = true`,
        [keyPrefix]
    );

    return result.rows[0] || null;
}

/**
 * Valida uma API key (verifica hash e se está ativa)
 * @param {string} apiKey - API key em plaintext
 * @returns {Promise<Object|null>} API key se válida, null caso contrário
 */
async function validate(apiKey) {
    const keyPrefix = extractKeyPrefix(apiKey);
    const keyRecord = await findByPrefix(keyPrefix);

    if (!keyRecord) {
        return null;
    }

    // Verificar se está ativa
    if (!keyRecord.is_active) {
        return null;
    }

    // Verificar se expirou
    if (keyRecord.expires_at && new Date() > new Date(keyRecord.expires_at)) {
        return null;
    }

    // Verificar hash
    const isValid = await verifyApiKey(apiKey, keyRecord.key_hash);

    if (!isValid) {
        return null;
    }

    // Atualizar last_used_at
    await updateLastUsed(keyRecord.id);

    return keyRecord;
}

/**
 * Lista todas as API keys
 * @param {Object} filters - Filtros opcionais
 * @param {boolean} filters.is_active - Filtrar por ativas/inativas
 * @param {number} filters.limit - Limite de resultados
 * @param {number} filters.offset - Offset para paginação
 * @returns {Promise<Array>} Lista de API keys
 */
async function findAll(filters = {}) {
    let query = `SELECT id, key_prefix, project_name, description, rate_limit_per_minute, is_active, last_used_at, created_at, expires_at
                 FROM api_keys
                 WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (filters.is_active !== undefined) {
        query += ` AND is_active = $${paramCount}`;
        params.push(filters.is_active);
        paramCount++;
    }

    query += ` ORDER BY created_at DESC`;

    if (filters.limit) {
        query += ` LIMIT $${paramCount}`;
        params.push(filters.limit);
        paramCount++;
    }

    if (filters.offset) {
        query += ` OFFSET $${paramCount}`;
        params.push(filters.offset);
    }

    const result = await pool.query(query, params);
    return result.rows;
}

/**
 * Atualiza uma API key
 * @param {string} keyId - UUID da API key
 * @param {Object} updates - Campos a atualizar
 * @returns {Promise<Object|null>} API key atualizada ou null
 */
async function update(keyId, updates) {
    const allowedFields = ['description', 'rate_limit_per_minute', 'is_active', 'expires_at'];

    const updateFields = [];
    const params = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            updateFields.push(`${key} = $${paramCount}`);
            params.push(value);
            paramCount++;
        }
    }

    if (updateFields.length === 0) {
        throw new Error('Nenhum campo válido para atualizar');
    }

    params.push(keyId);

    const query = `
        UPDATE api_keys
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING id, key_prefix, project_name, description, rate_limit_per_minute, is_active, last_used_at, created_at, expires_at
    `;

    const result = await pool.query(query, params);
    return result.rows[0] || null;
}

/**
 * Atualiza timestamp de último uso
 * @param {string} keyId - UUID da API key
 */
async function updateLastUsed(keyId) {
    await pool.query(
        `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
        [keyId]
    );
}

/**
 * Desativa uma API key (soft delete)
 * @param {string} keyId - UUID da API key
 * @returns {Promise<boolean>} true se desativou
 */
async function deactivate(keyId) {
    const result = await pool.query(
        `UPDATE api_keys SET is_active = false WHERE id = $1`,
        [keyId]
    );

    return result.rowCount > 0;
}

/**
 * Reativa uma API key
 * @param {string} keyId - UUID da API key
 * @returns {Promise<boolean>} true se reativou
 */
async function reactivate(keyId) {
    const result = await pool.query(
        `UPDATE api_keys SET is_active = true WHERE id = $1`,
        [keyId]
    );

    return result.rowCount > 0;
}

/**
 * Deleta uma API key permanentemente
 * @param {string} keyId - UUID da API key
 * @returns {Promise<boolean>} true se deletou
 */
async function remove(keyId) {
    const result = await pool.query(
        `DELETE FROM api_keys WHERE id = $1`,
        [keyId]
    );

    return result.rowCount > 0;
}

/**
 * Conta total de API keys
 * @param {boolean} activeOnly - Contar apenas ativas
 * @returns {Promise<number>} Quantidade de API keys
 */
async function count(activeOnly = false) {
    const query = activeOnly
        ? `SELECT COUNT(*) as count FROM api_keys WHERE is_active = true`
        : `SELECT COUNT(*) as count FROM api_keys`;

    const result = await pool.query(query);
    return parseInt(result.rows[0].count, 10);
}

module.exports = {
    create,
    findById,
    findByPrefix,
    validate,
    findAll,
    update,
    updateLastUsed,
    deactivate,
    reactivate,
    remove,
    count
};

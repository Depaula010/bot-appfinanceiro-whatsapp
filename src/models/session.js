// ========================================
// Model: Session
// ========================================
// CRUD e operações de banco de dados para sessões WhatsApp

const { pool } = require('../config/database');

/**
 * Cria uma nova sessão
 * @param {Object} data - Dados da sessão
 * @param {string} data.session_name - Nome único da sessão
 * @param {string} data.api_key_id - UUID da API key
 * @param {string} data.webhook_url - URL do webhook
 * @param {string} data.webhook_signature_key - Chave HMAC
 * @param {Object} data.metadata - Metadados adicionais (opcional)
 * @returns {Promise<Object>} Sessão criada
 */
async function create(data) {
    const { session_name, api_key_id, webhook_url, webhook_signature_key, metadata = {} } = data;

    const result = await pool.query(
        `INSERT INTO sessions (session_name, api_key_id, webhook_url, webhook_signature_key, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [session_name, api_key_id, webhook_url, webhook_signature_key, JSON.stringify(metadata)]
    );

    return result.rows[0];
}

/**
 * Busca sessão por ID
 * @param {string} sessionId - UUID da sessão
 * @returns {Promise<Object|null>} Sessão ou null
 */
async function findById(sessionId) {
    const result = await pool.query(
        `SELECT * FROM sessions WHERE id = $1`,
        [sessionId]
    );

    return result.rows[0] || null;
}

/**
 * Busca sessão por nome
 * @param {string} sessionName - Nome da sessão
 * @returns {Promise<Object|null>} Sessão ou null
 */
async function findByName(sessionName) {
    const result = await pool.query(
        `SELECT * FROM sessions WHERE session_name = $1`,
        [sessionName]
    );

    return result.rows[0] || null;
}

/**
 * Lista todas as sessões de uma API key
 * @param {string} apiKeyId - UUID da API key
 * @returns {Promise<Array>} Lista de sessões
 */
async function findByApiKey(apiKeyId) {
    const result = await pool.query(
        `SELECT * FROM sessions WHERE api_key_id = $1 ORDER BY created_at DESC`,
        [apiKeyId]
    );

    return result.rows;
}

/**
 * Lista sessões com filtros
 * @param {Object} filters - Filtros opcionais
 * @param {string} filters.api_key_id - Filtrar por API key
 * @param {string} filters.status - Filtrar por status
 * @param {number} filters.limit - Limite de resultados
 * @param {number} filters.offset - Offset para paginação
 * @returns {Promise<Array>} Lista de sessões
 */
async function findAll(filters = {}) {
    let query = `SELECT * FROM sessions WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (filters.api_key_id) {
        query += ` AND api_key_id = $${paramCount}`;
        params.push(filters.api_key_id);
        paramCount++;
    }

    if (filters.status) {
        query += ` AND status = $${paramCount}`;
        params.push(filters.status);
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
 * Atualiza uma sessão
 * @param {string} sessionId - UUID da sessão
 * @param {Object} updates - Campos a atualizar
 * @returns {Promise<Object|null>} Sessão atualizada ou null
 */
async function update(sessionId, updates) {
    const allowedFields = [
        'status',
        'phone_number',
        'qr_code',
        'qr_expires_at',
        'last_connected_at',
        'webhook_url',
        'webhook_signature_key',
        'metadata'
    ];

    const updateFields = [];
    const params = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            updateFields.push(`${key} = $${paramCount}`);
            params.push(key === 'metadata' ? JSON.stringify(value) : value);
            paramCount++;
        }
    }

    if (updateFields.length === 0) {
        throw new Error('Nenhum campo válido para atualizar');
    }

    params.push(sessionId);

    const query = `
        UPDATE sessions
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
    `;

    const result = await pool.query(query, params);
    return result.rows[0] || null;
}

/**
 * Atualiza status da sessão
 * @param {string} sessionId - UUID da sessão
 * @param {string} status - Novo status
 * @returns {Promise<Object|null>} Sessão atualizada
 */
async function updateStatus(sessionId, status) {
    return update(sessionId, { status });
}

/**
 * Atualiza QR code da sessão
 * @param {string} sessionId - UUID da sessão
 * @param {string} qrCode - QR code em base64
 * @param {Date} expiresAt - Data de expiração
 * @returns {Promise<Object|null>} Sessão atualizada
 */
async function updateQR(sessionId, qrCode, expiresAt = null) {
    return update(sessionId, {
        qr_code: qrCode,
        qr_expires_at: expiresAt || new Date(Date.now() + 60000) // 1 minuto
    });
}

/**
 * Limpa QR code da sessão
 * @param {string} sessionId - UUID da sessão
 */
async function clearQR(sessionId) {
    return update(sessionId, {
        qr_code: null,
        qr_expires_at: null
    });
}

/**
 * Deleta uma sessão
 * @param {string} sessionId - UUID da sessão
 * @returns {Promise<boolean>} true se deletou
 */
async function remove(sessionId) {
    const result = await pool.query(
        `DELETE FROM sessions WHERE id = $1`,
        [sessionId]
    );

    return result.rowCount > 0;
}

/**
 * Conta sessões por API key
 * @param {string} apiKeyId - UUID da API key
 * @returns {Promise<number>} Quantidade de sessões
 */
async function countByApiKey(apiKeyId) {
    const result = await pool.query(
        `SELECT COUNT(*) as count FROM sessions WHERE api_key_id = $1`,
        [apiKeyId]
    );

    return parseInt(result.rows[0].count, 10);
}

/**
 * Busca sessões ativas (connected) de uma API key
 * @param {string} apiKeyId - UUID da API key
 * @returns {Promise<Array>} Sessões ativas
 */
async function findActiveByApiKey(apiKeyId) {
    const result = await pool.query(
        `SELECT * FROM sessions WHERE api_key_id = $1 AND status = 'connected' ORDER BY last_connected_at DESC`,
        [apiKeyId]
    );

    return result.rows;
}

/**
 * Busca sessões idle (inativas por muito tempo)
 * @param {number} hours - Horas de inatividade
 * @returns {Promise<Array>} Sessões idle
 */
async function findIdleSessions(hours = 24) {
    const safeHours = Math.max(1, Math.min(parseInt(hours, 10) || 24, 8760));
    const result = await pool.query(
        `SELECT * FROM sessions
         WHERE status = 'connected'
         AND last_connected_at < NOW() - INTERVAL '1 hour' * $1`,
        [safeHours]
    );

    return result.rows;
}

module.exports = {
    create,
    findById,
    findByName,
    findByApiKey,
    findAll,
    update,
    updateStatus,
    updateQR,
    clearQR,
    remove,
    countByApiKey,
    findActiveByApiKey,
    findIdleSessions
};

// ========================================
// Configuração do Pool PostgreSQL
// ========================================
// Pool de conexões otimizado para API multi-sessão

const { Pool } = require('pg');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// Configurações do pool
const poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
    } : false,
    max: parseInt(process.env.DB_POOL_MAX || '50', 10), // Aumentado para multi-sessão
    min: parseInt(process.env.DB_POOL_MIN || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: false
};

// Criar pool
const pool = new Pool(poolConfig);

// Event listeners para monitoramento
pool.on('connect', () => {
    logger.debug('Nova conexão PostgreSQL estabelecida');
});

pool.on('acquire', () => {
    logger.debug('Conexão adquirida do pool');
});

pool.on('error', (err) => {
    logger.error({ err }, 'Erro inesperado no pool PostgreSQL');
});

pool.on('remove', () => {
    logger.debug('Conexão removida do pool');
});

/**
 * Testa a conexão com o banco de dados
 * @returns {Promise<boolean>} true se conectou com sucesso
 */
async function testConnection() {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        logger.info('✅ Conexão com PostgreSQL testada com sucesso');
        logger.debug({ timestamp: result.rows[0].now }, 'Timestamp do banco');
        return true;
    } catch (error) {
        logger.error({ err: error }, '❌ Falha ao conectar com PostgreSQL');
        return false;
    }
}

/**
 * Retorna estatísticas do pool
 * @returns {Object} Estatísticas do pool
 */
function getPoolStats() {
    return {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
    };
}

/**
 * Encerra o pool gracefully
 */
async function closePool() {
    logger.info('Fechando pool PostgreSQL...');
    await pool.end();
    logger.info('✅ Pool PostgreSQL fechado');
}

// NOTA: O graceful shutdown é gerenciado pelo index.js
// para garantir a ordem correta de fechamento (sessões primeiro, depois pool)

module.exports = {
    pool,
    testConnection,
    getPoolStats,
    closePool
};

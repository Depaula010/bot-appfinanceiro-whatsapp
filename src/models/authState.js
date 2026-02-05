// ========================================
// Auth State para Baileys (Multi-Sessão) - CORRIGIDO v2
// ========================================
// Gerencia estado de autenticação do Baileys no PostgreSQL por session_uuid

const { initAuthCreds, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { pool } = require('../config/database');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// ====================================================================
// SERIALIZAÇÃO DE BUFFERS - Implementação própria
// Como o Baileys usa ESM e nosso projeto usa CommonJS, implementamos
// nosso próprio replacer/reviver para lidar com Buffers
// ====================================================================

/**
 * Converte Buffers para Base64 ao salvar em JSON
 */
const bufferReplacer = (key, value) => {
    if (value && typeof value === 'object') {
        if (Buffer.isBuffer(value)) {
            return {
                type: 'Buffer',
                data: value.toString('base64')
            };
        }
        // Suporta Uint8Array também
        if (value.constructor && value.constructor.name === 'Uint8Array') {
            return {
                type: 'Buffer',
                data: Buffer.from(value).toString('base64')
            };
        }
    }
    return value;
};

/**
 * Converte Base64 de volta para Buffers ao ler JSON
 */
const bufferReviver = (key, value) => {
    if (value && typeof value === 'object' && value.type === 'Buffer') {
        if (Array.isArray(value.data)) {
            // Formato antigo: array de bytes
            return Buffer.from(value.data);
        }
        if (typeof value.data === 'string') {
            // Formato novo: base64 string
            return Buffer.from(value.data, 'base64');
        }
    }
    return value;
};

/**
 * Cria auth state para uma sessão específica
 * Compatível com baileys useAuthState
 *
 * @param {string} sessionUuid - UUID da sessão
 * @returns {Promise<{state: {creds: any, keys: any}, saveCreds: Function, loadCreds: Function, clearCreds: Function}>}
 */
async function createAuthState(sessionUuid) {
    // Identificador para a coluna session_id (NOT NULL, legado)
    const sessionId = `session_${sessionUuid}`;

    // Objeto que mantém referência mutável das credenciais
    const authState = {
        creds: initAuthCreds(),
        keys: {}
    };

    /**
     * Upsert genérico: UPDATE primeiro, INSERT se não existir
     * Com retry para evitar race conditions
     */
    const upsertAuthData = async (dataKey, dataValue, retries = 3) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const updateResult = await pool.query(
                    `UPDATE baileys_auth SET data_value = $3, updated_at = NOW()
                     WHERE session_uuid = $1 AND data_key = $2`,
                    [sessionUuid, dataKey, dataValue]
                );

                if (updateResult.rowCount === 0) {
                    await pool.query(
                        `INSERT INTO baileys_auth (session_id, session_uuid, data_key, data_value)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (session_uuid, data_key) DO UPDATE SET data_value = $4, updated_at = NOW()`,
                        [sessionId, sessionUuid, dataKey, dataValue]
                    );
                }
                return; // Sucesso, sai do loop
            } catch (error) {
                if (error.code === '23505' && attempt < retries) {
                    // Duplicate key - tentar novamente com UPDATE
                    logger.debug({ dataKey, attempt }, 'Retrying upsert due to race condition');
                    continue;
                }
                throw error;
            }
        }
    };

    /**
     * Carrega credenciais do banco de dados
     */
    const loadCreds = async () => {
        try {
            const result = await pool.query(
                `SELECT data_key, data_value
                 FROM baileys_auth
                 WHERE session_uuid = $1`,
                [sessionUuid]
            );

            for (const row of result.rows) {
                const { data_key, data_value } = row;

                if (!data_value) continue;

                try {
                    // Usar nosso bufferReviver para deserialização correta
                    const parsedValue = JSON.parse(data_value, bufferReviver);

                    if (data_key === 'creds') {
                        // Mesclar com creds existentes (mantém campos que não foram salvos)
                        Object.assign(authState.creds, parsedValue);
                    } else if (data_key.startsWith('key-')) {
                        // Estrutura de keys do Baileys
                        const keyPath = data_key.replace('key-', '').split('-');
                        let target = authState.keys;

                        for (let i = 0; i < keyPath.length - 1; i++) {
                            if (!target[keyPath[i]]) {
                                target[keyPath[i]] = {};
                            }
                            target = target[keyPath[i]];
                        }

                        target[keyPath[keyPath.length - 1]] = parsedValue;
                    }
                } catch (parseError) {
                    logger.error({ err: parseError, dataKey: data_key }, 'Erro ao parsear auth data - ignorando');
                }
            }

            logger.debug({ sessionUuid, keysLoaded: result.rows.length }, 'Auth state carregado');
        } catch (error) {
            logger.error({ err: error, sessionUuid }, 'Erro ao carregar auth state');
            throw error;
        }
    };

    /**
     * Salva as credenciais no banco de dados
     * CRÍTICO: Usa bufferReplacer para serialização correta de Buffers
     */
    const saveCreds = async () => {
        try {
            // Validar se as credenciais não estão vazias
            if (!authState.creds || !authState.creds.noiseKey || !authState.creds.signedIdentityKey) {
                logger.warn({ sessionUuid }, 'Tentativa de salvar credenciais incompletas - ignorando');
                return;
            }

            const serializedCreds = JSON.stringify(authState.creds, bufferReplacer);

            // Validar se a serialização funcionou
            if (serializedCreds.length < 100) { // Credenciais válidas sempre são maiores
                logger.error({ sessionUuid, size: serializedCreds.length }, 'Credenciais serializadas muito pequenas - possível corrupção');
                return;
            }

            await upsertAuthData('creds', serializedCreds);
            logger.debug({ sessionUuid, size: serializedCreds.length }, 'Credenciais salvas com sucesso');
        } catch (error) {
            logger.error({ err: error, sessionUuid }, 'ERRO CRÍTICO ao salvar credenciais');
            // Não lançar erro para não interromper o fluxo do Baileys
        }
    };

    /**
     * Salva uma chave específica
     * @param {string} keyPath - Caminho da chave (ex: 'app-state-sync-key-AAAAAAA')
     * @param {*} value - Valor da chave
     */
    const saveKey = async (keyPath, value) => {
        const dataKey = `key-${keyPath}`;

        try {
            if (value === null || value === undefined) {
                // Deletar chave
                await pool.query(
                    `DELETE FROM baileys_auth WHERE session_uuid = $1 AND data_key = $2`,
                    [sessionUuid, dataKey]
                );
            } else {
                // Inserir/atualizar chave com bufferReplacer
                await upsertAuthData(dataKey, JSON.stringify(value, bufferReplacer));
            }
        } catch (error) {
            logger.error({ err: error, keyPath }, 'Erro ao salvar key');
        }
    };

    /**
     * Limpa todas as credenciais da sessão
     */
    const clearCreds = async () => {
        await pool.query(
            `DELETE FROM baileys_auth WHERE session_uuid = $1`,
            [sessionUuid]
        );

        // Resetar para valores iniciais
        authState.creds = initAuthCreds();
        authState.keys = {};

        logger.info({ sessionUuid }, 'Auth state limpo');
    };

    // Criar signal key store com cache
    const signalKeyStore = makeCacheableSignalKeyStore(
        {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    const keyPath = `${type}.${id}`;
                    const parts = keyPath.split('.');
                    let target = authState.keys;

                    for (const part of parts) {
                        if (target && target[part] !== undefined) {
                            target = target[part];
                        } else {
                            target = undefined;
                            break;
                        }
                    }

                    if (target !== undefined) {
                        data[id] = target;
                    }
                }
                return data;
            },
            set: async (data) => {
                // Processar todas as keys em batch para evitar race conditions
                const savePromises = [];

                for (const category in data) {
                    for (const id in data[category]) {
                        const keyPath = `${category}-${id}`;
                        const value = data[category][id];

                        // Atualizar em memória primeiro
                        if (!authState.keys[category]) {
                            authState.keys[category] = {};
                        }
                        authState.keys[category][id] = value;

                        // Agendar salvamento no banco
                        savePromises.push(saveKey(keyPath, value));
                    }
                }

                // Esperar todos os salvamentos completarem
                await Promise.allSettled(savePromises);
            }
        },
        pino({ level: 'silent' }) // Logger silencioso para key store
    );

    return {
        state: {
            creds: authState.creds,
            keys: signalKeyStore
        },
        saveCreds,
        loadCreds,
        clearCreds
    };
}

/**
 * Verifica se uma sessão tem credenciais salvas
 * @param {string} sessionUuid - UUID da sessão
 * @returns {Promise<boolean>} true se existem credenciais
 */
async function hasAuthState(sessionUuid) {
    const result = await pool.query(
        `SELECT COUNT(*) as count
         FROM baileys_auth
         WHERE session_uuid = $1 AND data_key = 'creds'`,
        [sessionUuid]
    );

    return parseInt(result.rows[0].count, 10) > 0;
}

/**
 * Remove auth state de uma sessão
 * @param {string} sessionUuid - UUID da sessão
 */
async function removeAuthState(sessionUuid) {
    await pool.query(
        `DELETE FROM baileys_auth WHERE session_uuid = $1`,
        [sessionUuid]
    );
    logger.info({ sessionUuid }, 'Auth state removido');
}

module.exports = {
    createAuthState,
    hasAuthState,
    removeAuthState
};

// ========================================
// Auth State para Baileys (Multi-Sessão)
// ========================================
// Gerencia estado de autenticação do Baileys no PostgreSQL por session_uuid

const { initAuthCreds, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { pool } = require('../config/database');
const pino = require('pino');

/**
 * Converte Buffers para Base64 ao salvar em JSON
 */
const replacer = (key, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return {
            type: 'Buffer',
            data: value.toString('base64')
        };
    }
    return value;
};

/**
 * Converte Base64 de volta para Buffers ao ler JSON
 */
const reviver = (key, value) => {
    if (typeof value === 'object' && value !== null && value.type === 'Buffer' && value.data) {
        return Buffer.from(value.data, 'base64');
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
    // Inicializar credenciais vazias
    let creds = initAuthCreds();
    let keys = {};

    /**
     * Carrega credenciais do banco de dados
     */
    const loadCreds = async () => {
        const result = await pool.query(
            `SELECT session_id, data_key, data_value
             FROM baileys_auth
             WHERE session_uuid = $1`,
            [sessionUuid]
        );

        for (const row of result.rows) {
            const { data_key, data_value } = row;

            if (!data_value) continue;

            const parsedValue = JSON.parse(data_value, reviver);

            if (data_key === 'creds') {
                creds = parsedValue;
            } else if (data_key.startsWith('key-')) {
                // Estrutura de keys do Baileys
                const keyPath = data_key.replace('key-', '').split('-');
                let target = keys;

                for (let i = 0; i < keyPath.length - 1; i++) {
                    if (!target[keyPath[i]]) {
                        target[keyPath[i]] = {};
                    }
                    target = target[keyPath[i]];
                }

                target[keyPath[keyPath.length - 1]] = parsedValue;
            }
        }
    };

    /**
     * Salva as credenciais no banco de dados
     */
    const saveCreds = async () => {
        // Salvar creds
        await pool.query(
            `INSERT INTO baileys_auth (session_uuid, data_key, data_value)
             VALUES ($1, $2, $3)
             ON CONFLICT (session_uuid, data_key)
             DO UPDATE SET data_value = EXCLUDED.data_value`,
            [sessionUuid, 'creds', JSON.stringify(creds, replacer)]
        );
    };

    /**
     * Salva uma chave específica
     * @param {string} keyPath - Caminho da chave (ex: 'app-state-sync-key-AAAAAAA')
     * @param {*} value - Valor da chave
     */
    const saveKey = async (keyPath, value) => {
        const dataKey = `key-${keyPath}`;

        if (value === null || value === undefined) {
            // Deletar chave
            await pool.query(
                `DELETE FROM baileys_auth WHERE session_uuid = $1 AND data_key = $2`,
                [sessionUuid, dataKey]
            );
        } else {
            // Inserir/atualizar chave
            await pool.query(
                `INSERT INTO baileys_auth (session_uuid, data_key, data_value)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (session_uuid, data_key)
                 DO UPDATE SET data_value = EXCLUDED.data_value`,
                [sessionUuid, dataKey, JSON.stringify(value, replacer)]
            );
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
        creds = initAuthCreds();
        keys = {};
    };

    // Criar signal key store com cache
    const signalKeyStore = makeCacheableSignalKeyStore(
        {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    const keyPath = `${type}.${id}`;
                    const parts = keyPath.split('.');
                    let target = keys;

                    for (const part of parts) {
                        if (target[part] !== undefined) {
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
                for (const category in data) {
                    for (const id in data[category]) {
                        const keyPath = `${category}.${id}`;
                        const value = data[category][id];

                        // Atualizar em memória
                        if (!keys[category]) {
                            keys[category] = {};
                        }
                        keys[category][id] = value;

                        // Salvar no banco
                        await saveKey(keyPath, value);
                    }
                }
            }
        },
        pino({ level: 'silent' }) // Logger silencioso para key store
    );

    return {
        state: {
            creds,
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
}

module.exports = {
    createAuthState,
    hasAuthState,
    removeAuthState
};

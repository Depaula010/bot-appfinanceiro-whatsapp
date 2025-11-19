// ========= 0. IMPORTAÇÕES =========
const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    DisconnectReason,
    jidNormalizedUser,
    delay,
    makeCacheableSignalKeyStore,
    initAuthCreds
} = require('@whiskeysockets/baileys');
const { Pool } = require('pg');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');

// ========= 1. CONFIGURAÇÕES =========
const app = express();
const port = process.env.PORT || 3000;
let ultimoDiaExecutado = null;

// Validação de variáveis de ambiente obrigatórias
const REQUIRED_ENV_VARS = ['DATABASE_URL', 'ADMIN_WHATSAPP_NUMBER', 'API_SECRET_KEY'];
REQUIRED_ENV_VARS.forEach(varName => {
    if (!process.env[varName]) {
        console.error(`ERRO CRÍTICO: Variável de ambiente ${varName} não definida.`);
        process.exit(1);
    }
});

const ADMIN_WHATSAPP_NUMBER = process.env.ADMIN_WHATSAPP_NUMBER;
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// Configuração do Pool PostgreSQL
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// Cliente do Baileys
let sock;
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// ========= 2. STORE DE AUTENTICAÇÃO NO POSTGRESQL (COM CORREÇÃO) =========

/**
 * (CORREÇÃO) Converte Buffers para Base64 ao salvar em JSON
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
 * (CORREÇÃO) Converte Base64 de volta para Buffers ao ler JSON
 */
const reviver = (key, value) => {
    if (typeof value === 'object' && value !== null && value.type === 'Buffer' && value.data) {
        return Buffer.from(value.data, 'base64');
    }
    return value;
};


/**
 * Cria tabelas necessárias no banco
 */
async function inicializarBanco() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS baileys_auth (
                session_id VARCHAR(100) NOT NULL,
                data_key VARCHAR(100) NOT NULL,
                data_value TEXT NOT NULL,
                PRIMARY KEY (session_id, data_key)
            )
        `);
        console.log('[DATABASE] Tabela baileys_auth criada/verificada.');
    } catch (error) {
        console.error('[DATABASE] Erro ao criar tabelas:', error.message);
        throw error;
    }
}

/**
 * Implementação customizada do useAuthState usando PostgreSQL
 */
function useDatabaseAuthState(sessionId = 'baileys_session') {

    // Lê dados do banco
    const readData = async (key) => {
        try {
            const result = await pool.query(
                'SELECT data_value FROM baileys_auth WHERE session_id = $1 AND data_key = $2',
                [sessionId, key]
            );

            if (result.rows.length > 0) {
                const dataValue = result.rows[0].data_value; // Isso é uma STRING

                const firstChar = dataValue.substring(0, 1);
                if (firstChar === '{' || firstChar === '[') {
                    // (CORREÇÃO) Usa o 'reviver' para restaurar Buffers
                    return JSON.parse(dataValue, reviver);
                }

                // (CORREÇÃO) Se não for JSON, é um Buffer salvo diretamente como Base64
                return Buffer.from(dataValue, 'base64');
            }
            return null;
        } catch (error) {
            console.error(`[AUTH] Erro ao ler ${key}:`, error.message);
            return null;
        }
    };

    // Escreve dados no banco
    const writeData = async (key, data) => {
        let dataValue;

        // (CORREÇÃO) Se for um Buffer, converte para Base64
        if (Buffer.isBuffer(data)) {
            dataValue = data.toString('base64');
        } else {
            // (CORREÇÃO) Se for JSON, usa o 'replacer' para tratar Buffers internos
            dataValue = JSON.stringify(data, replacer);
        }

        try {
            await pool.query(`
            INSERT INTO baileys_auth (session_id, data_key, data_value)
            VALUES ($1, $2, $3)
            ON CONFLICT (session_id, data_key)
            DO UPDATE SET data_value = $3
        `, [sessionId, key, dataValue]);

        } catch (error) {
            console.error(`[AUTH] Erro ao salvar ${key}:`, error.message);
        }
    };

    // Remove dados do banco
    const removeData = async (key) => {
        try {
            await pool.query(
                'DELETE FROM baileys_auth WHERE session_id = $1 AND data_key = $2',
                [sessionId, key]
            );
        } catch (error) {
            console.error(`[AUTH] Erro ao remover ${key}:`, error.message);
        }
    };

    // State object compatível com Baileys
    const state = {
        creds: null,
        keys: {}
    };

    // Carrega credenciais
    const loadCreds = async () => {
        state.creds = await readData('creds') || initAuthCreds();
    };

    // Salva credenciais
    const saveCreds = async () => {
        await writeData('creds', state.creds);
    };

    // Define o 'get' e 'set' das chaves diretamente no objeto 'state.keys'
    state.keys = {
        get: async (type, ids) => {
            const data = {};
            for (const id of ids) {
                const key = `${type}-${id}`;
                const value = await readData(key);
                if (value) {
                    data[id] = value;
                }
            }
            return data;
        },
        set: async (data) => {
            for (const category in data) {
                for (const id in data[category]) {
                    const key = `${category}-${id}`;
                    const value = data[category][id];
                    if (value) {
                        await writeData(key, value);
                    } else {
                        await removeData(key);
                    }
                }
            }
        }
    };

    // Agora, retorne o objeto 'state' principal
    return {
        state: state, // Retorna o objeto 'state' vivo, não um snapshot
        loadCreds,
        saveCreds
    };
}

// ========= 3. FUNÇÕES AUXILIARES =========

/**
 * Formata número para o padrão do WhatsApp
 */
function formatarChatId(numero) {
    const numeroLimpo = numero.replace(/\D/g, '');
    return `${numeroLimpo}@s.whatsapp.net`;
}

/**
 * Envia notificação para o admin
 */
async function notificarAdmin(mensagem) {
    try {
        if (!sock || !sock.user) {
            console.warn('[ADMIN] Bot não está pronto para enviar notificação.');
            return;
        }

        const adminChatId = formatarChatId(ADMIN_WHATSAPP_NUMBER);
        const fusoHorarioSP = { timeZone: 'America/Sao_Paulo' };
        const dataFormatada = new Date().toLocaleString('pt-BR', fusoHorarioSP);

        const mensagemCompleta = `${mensagem}\n\n*Horário:* ${dataFormatada}`;

        await sock.sendMessage(adminChatId, { text: mensagemCompleta });
        console.log('[ADMIN] Notificação enviada com sucesso.');
    } catch (error) {
        console.error('[ADMIN] Erro ao enviar notificação:', error.message);
    }
}

// ========= 4. FUNÇÃO PRINCIPAL DO BOT =========

async function connectToWhatsApp() {
    console.log('[BAILEYS] Iniciando conexão com o WhatsApp...');

    try {
        // Inicializa banco de dados
        await inicializarBanco();

        // Obtém estado de autenticação do PostgreSQL
        const { state, saveCreds, loadCreds } = useDatabaseAuthState('baileys_session');

        // Carrega credenciais do banco
        await loadCreds();

        // Obtém versão mais recente do WhatsApp Web
        const { version } = await fetchLatestBaileysVersion();
        console.log(`[BAILEYS] Usando WhatsApp Web v${version.join('.')}`);

        // Cria socket do Baileys
        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: state.keys
            },
            markOnlineOnConnect: true,
            syncFullHistory: false,
            browser: ['Bot Financeiro', 'Chrome', '1.0.0'],
            getMessage: async (key) => {
                return { conversation: '' };
            }
        });

        // ===== EVENTO: Atualização da Conexão =====
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Exibe QR Code
            if (qr) {
                console.log('\n========================================');
                console.log('🔐 LOGIN NECESSÁRIO');
                console.log('Escaneie o QR Code abaixo com o WhatsApp:');
                console.log('========================================');
                qrcode.generate(qr, { small: true });
                console.log('========================================');
                console.log('⏳ Aguardando leitura do QR Code...\n');
            }

            // Conexão fechada
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.warn(`[CONEXÃO] Fechada. Motivo: ${lastDisconnect?.error?.message || 'Desconhecido'}`);
                console.warn(`[CONEXÃO] Status Code: ${statusCode}`);
                console.warn(`[CONEXÃO] Reconectar: ${shouldReconnect}`);

                if (shouldReconnect) {
                    console.log('[CONEXÃO] Reconectando em 5 segundos...');
                    await delay(5000);
                    connectToWhatsApp();
                } else {
                    console.error('[CONEXÃO] ⚠️  LOGOUT DETECTADO!');
                    console.error('[CONEXÃO] Execute: DELETE FROM baileys_auth WHERE session_id = \'baileys_session\';');
                    console.error('[CONEXÃO] Depois reinicie o serviço.');
                    await notificarAdmin('🔴 *Bot Desconectado*\n\nLogout detectado. É necessário reautenticar o bot.');
                }
            }

            // Conexão aberta
            if (connection === 'open') {
                console.log('\n✅ *** BOT CONECTADO COM SUCESSO! ***');
                console.log(`📱 Número: ${sock.user.id}`);
                console.log(`👤 Nome: ${sock.user.name || 'N/A'}\n`);

                // Notifica admin após delay
                setTimeout(() => {
                    notificarAdmin('✅ *Bot Financeiro Online*\n\nServiço conectado com sucesso ao WhatsApp!');
                }, 10000);
            }
        });

        // ===== EVENTO: Salvar Credenciais =====
        sock.ev.on('creds.update', async () => {
            await saveCreds();
        });

        // ===== EVENTO: Mensagens Recebidas =====
        sock.ev.on('messages.upsert', async (m) => {
            let msg;
            try {
                if (!m.messages || m.messages.length === 0) return;

                msg = m.messages[0];

                // Filtros: ignora mensagens do próprio bot, broadcasts, sem texto
                if (!msg.message ||
                    msg.key.fromMe ||
                    !msg.key.remoteJid ||
                    msg.key.remoteJid === 'status@broadcast') {
                    return;
                }

                // Extrai texto da mensagem
                const msgBody = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    '';

                if (!msgBody) return;

                const from = msg.key.remoteJid;
                const fromNumber = jidNormalizedUser(from).replace('@s.whatsapp.net', '');

                console.log(`[MENSAGEM] De: ${fromNumber} | Texto: "${msgBody}"`);

                // Marca como lida
                await sock.readMessages([msg.key]);

                // Envia para o backend Python
                const response = await axios.post(
                    `${PYTHON_API_URL}/webhook-whatsapp`,
                    {
                        texto: msgBody,
                        numero_remetente: fromNumber
                    },
                    {
                        headers: { 'x-api-key': API_SECRET_KEY },
                        timeout: 30000
                    }
                );

                // Reação de sucesso
                await sock.sendMessage(from, {
                    react: { text: '👍', key: msg.key }
                });

                // Envia resposta
                if (response.data?.resposta) {
                    await sock.sendMessage(from, {
                        text: response.data.resposta
                    });
                    console.log(`[RESPOSTA] Enviada para ${fromNumber}`);
                }

            } catch (error) {
                console.error('[ERRO] Falha ao processar mensagem:', error.message);

                try {
                    await sock.sendMessage(msg.key.remoteJid, {
                        react: { text: '❌', key: msg.key }
                    });
                } catch (e) {
                    console.error('[ERRO] Não foi possível enviar reação de erro:', e.message);
                }
            }
        });

    } catch (error) {
        console.error('[BAILEYS] Erro crítico ao conectar:', error);
        console.log('[BAILEYS] Tentando reconectar em 10 segundos...');
        await delay(10000);
        connectToWhatsApp();
    }
}

// ========= 5. SERVIDOR EXPRESS =========

app.use(express.json());

// Middleware de log
app.use((req, res, next) => {
    // console.log(`[EXPRESS] ${req.method} ${req.path}`);
    next();
});

// ===== ROTA: Health Check + Cron Job =====
app.get('/ping', async (req, res) => {
    // console.log('[HEALTH] Ping recebido!');

    const dataAtual = new Date();
    const horaNoBrasil = new Date(
        dataAtual.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    ).getHours();
    const diaNoBrasil = dataAtual.getDate();
    const HORA_DE_RODAR = 8;

    // Lógica do Cron Job
    if (horaNoBrasil === HORA_DE_RODAR && diaNoBrasil !== ultimoDiaExecutado) {
        console.log(`[MOTOR-CRON] Hora de rodar detectada (${HORA_DE_RODAR}h)!`);
        ultimoDiaExecutado = diaNoBrasil;

        axios.post(
            `${PYTHON_API_URL}/admin/run-motor-agendamentos`,
            {},
            {
                headers: { 'x-api-key': API_SECRET_KEY },
                timeout: 60000
            }
        )
            .then(() => {
                console.log('[MOTOR-CRON] Backend processou agendamentos com sucesso.');
            })
            .catch(error => {
                console.error('[MOTOR-CRON] ERRO:', error.message);
                ultimoDiaExecutado = null;
            });
    }

    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        bot_connected: !!(sock && sock.user)
    });
});

// ===== ROTA: Enviar Mensagem =====
app.post('/enviar-mensagem', async (req, res) => {
    const secret = req.headers['x-api-key'];

    if (secret !== API_SECRET_KEY) {
        console.warn('[ENVIAR] Bloqueado: API Key inválida.');
        return res.status(401).json({
            status: 'erro',
            mensagem: 'Não autorizado'
        });
    }

    const { numero, mensagem } = req.body;

    if (!numero || !mensagem) {
        console.warn('[ENVIAR] Erro 400: Parâmetros faltando.');
        return res.status(400).json({
            status: 'erro',
            mensagem: "Parâmetros 'numero' e 'mensagem' são obrigatórios"
        });
    }

    if (!sock || !sock.user) {
        console.warn('[ENVIAR] Erro 503: Bot não está conectado.');
        return res.status(503).json({
            status: 'erro',
            mensagem: 'Bot não está pronto. Aguarde a conexão.'
        });
    }

    try {
        const chatId = formatarChatId(numero);

        // Verifica se o número existe no WhatsApp
        const [result] = await sock.onWhatsApp(chatId);

        if (!result || !result.exists) {
            console.warn(`[ENVIAR] Erro 404: Número não registrado: ${numero}`);
            return res.status(404).json({
                status: 'erro',
                mensagem: 'Número não encontrado no WhatsApp.'
            });
        }

        // Envia a mensagem
        await sock.sendMessage(chatId, { text: mensagem });
        console.log(`[ENVIAR] ✅ Mensagem enviada para ${numero}.`);

        res.status(200).json({
            status: 'sucesso',
            mensagem: 'Mensagem enviada com sucesso.'
        });

    } catch (err) {
        console.error(`[ENVIAR] Erro 500 ao enviar para ${numero}:`, err.message);
        res.status(500).json({
            status: 'erro',
            mensagem: 'Falha ao enviar mensagem',
            detalhe: err.message
        });
    }
});

// ===== ROTA: Status do Bot =====
app.get('/status', (req, res) => {
    const botStatus = {
        connected: !!(sock && sock.user),
        user: sock?.user ? {
            id: sock.user.id,
            name: sock.user.name
        } : null,
        timestamp: new Date().toISOString()
    };

    res.status(200).json(botStatus);
});

// ===== ROTA: Limpar Sessão (Útil para forçar novo QR Code) =====
app.post('/limpar-sessao', async (req, res) => {
    const secret = req.headers['x-api-key'];

    if (secret !== API_SECRET_KEY) {
        return res.status(401).json({
            status: 'erro',
            mensagem: 'Não autorizado'
        });
    }

    try {
        await pool.query("DELETE FROM baileys_auth WHERE session_id = 'baileys_session'");
        console.log('[ADMIN] Sessão limpa do banco de dados.');

        res.status(200).json({
            status: 'sucesso',
            mensagem: 'Sessão limpa. Reinicie o serviço para gerar novo QR Code.'
        });
    } catch (error) {
        console.error('[ADMIN] Erro ao limpar sessão:', error.message);
        res.status(500).json({
            status: 'erro',
            mensagem: 'Falha ao limpar sessão'
        });
    }
});

// Tratamento de erros
process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROCESS] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[PROCESS] Uncaught Exception:', error);
    process.exit(1);
});

// ========= 6. INICIALIZAÇÃO =========

connectToWhatsApp().catch(error => {
    console.error('[INIT] Erro ao iniciar bot:', error);
    process.exit(1);
});

app.listen(port, () => {
    console.log(`\n🚀 [API] Servidor rodando na porta ${port}`);
    console.log(`📦 [API] Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 [DATABASE] Autenticação salva no PostgreSQL\n`);
});
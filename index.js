// ========= 0. IMPORTAÇÕES =========
const qrcode = require('qrcode-terminal');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg'); // Driver do PostgreSQL

const app = express();
const port = process.env.PORT || 3000;
let ultimoDiaExecutado = null;

// ========= 1. CONFIGURAÇÕES =========
// [Adicionar em index.js, na Seção 1. CONFIGURAÇÕES]
const ADMIN_WHATSAPP_NUMBER = '553194001072'; // <-- ADICIONE ESTA LINHA
const PYTHON_API_URL = 'https://app-controle-financeiro-oh32.onrender.com';
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'uma-senha-bem-forte-12345';
// --- NOVA CONFIGURAÇÃO DE BANCO ---
// A MESMA DATABASE_URL usada pelo seu app Python
const DATABASE_URL = process.env.DATABASE_URL; 

if (!DATABASE_URL) {
    console.error("ERRO CRÍTICO: Variável de ambiente DATABASE_URL não definida.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL
});

// --- NOSSO 'STORE' MANUAL PARA O POSTGRESQL ---
// Esta classe diz ao RemoteAuth como salvar, carregar e deletar a sessão
class PgStore {
    constructor(pool, sessionName) {
        this.pool = pool;
        this.sessionName = sessionName;
    }

    async save(session) {
        const sessionData = JSON.stringify(session);
        console.log(`[PgStore] Salvando sessão no DB: ${this.sessionName}`);
        
        const query = `
            INSERT INTO wwebjs_auth_sessions (session_name, session_data, created_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (session_name)
            DO UPDATE SET session_data = $2;
        `;
        
        try {
            await this.pool.query(query, [this.sessionName, sessionData]);
            console.log(`[PgStore] Sessão salva com sucesso.`);
        } catch (err) {
            console.error('[PgStore] ERRO AO SALVAR SESSÃO:', err);
        }
    }

    async load() {
        console.log(`[PgStore] Carregando sessão do DB: ${this.sessionName}`);
        const query = 'SELECT session_data FROM wwebjs_auth_sessions WHERE session_name = $1;';
        
        try {
            const { rows } = await this.pool.query(query, [this.sessionName]);
            if (rows.length > 0) {
                const sessionData = rows[0].session_data;
                console.log(`[PgStore] Sessão encontrada. Carregando...`);
                return JSON.parse(sessionData);
            }
            console.log(`[PgStore] Nenhuma sessão encontrada no DB.`);
            return undefined;
        } catch (err) {
            console.error('[PgStore] ERRO AO CARREGAR SESSÃO:', err);
            return undefined;
        }
    }

    async delete() {
        console.log(`[PgStore] Deletando sessão do DB: ${this.sessionName}`);
        const query = 'DELETE FROM wwebjs_auth_sessions WHERE session_name = $1;';
        
        try {
            await this.pool.query(query, [this.sessionName]);
            console.log(`[PgStore] Sessão deletada com sucesso.`);
        } catch (err) {
            console.error('[PgStore] ERRO AO DELETAR SESSÃO:', err);
        }
    }
}
// --- FIM DO 'STORE' MANUAL ---


// ========= 2. CONFIGURAÇÃO DO BOT WHATSAPP (COM RemoteAuth) =========
console.log("Iniciando cliente do WhatsApp com RemoteAuth (PostgreSQL)...");

// Instancia o nosso 'store' manual
const store = new PgStore(pool, 'bot-financeiro-sessao');

const client = new Client({
    // SUBSTITUI LocalAuth POR RemoteAuth
    authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000 // Salva a sessão no DB a cada 5 minutos
    }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

client.on('qr', qr => { 
    console.log("========================================");
    console.log("LOGIN NECESSÁRIO: Escaneie com o celular que será o BOT:");
    qrcode.generate(qr, { small: true });
    console.log("========================================");
});

client.on('ready', async () => {
    console.log('*** BOT ESTÁ PRONTO E CONECTADO! ***');

    // Loga qual número está sendo usado como bot
    if (client.info && client.info.wid) {
        console.log(`[INFO] Logado como: ${client.info.wid.user}`);
    } else {
        console.log('[INFO] Informações do cliente (wid) não disponíveis no momento.');
    }

    // --- Notificação de Startup para o Admin ---
    const adminChatId = `${ADMIN_WHATSAPP_NUMBER}@c.us`;
    const fusoHorarioSP = { timeZone: 'America/Sao_Paulo' };
    const dataFormatada = new Date().toLocaleString('pt-BR', fusoHorarioSP);

    const startupMessage = `✅ *Bot Financeiro (Online)*\n\nServiço reiniciado e conectado com sucesso no Render.\n\n*Horário:* ${dataFormatada}`;

    // Adiciona um pequeno delay (10s) para garantir que a sessão esteja 100% pronta para enviar
    setTimeout(async () => {
        try {
            await client.sendMessage(adminChatId, startupMessage);
            console.log(`[STARTUP] Notificação de "Bot Online" enviada para o admin.`);
        } catch (err) {
            console.error(`[STARTUP] Falha ao enviar notificação de startup para ${adminChatId}.`, err);
        }
    }, 10000); // 10 segundos de delay
});

client.on('auth_failure', async (msg) => {
    console.error(`[FALHA DE AUTENTICAÇÃO] Não foi possível autenticar: ${msg}`);
    console.log('[FALHA DE AUTENTICAÇÃO] Limpando a sessão do banco de dados...');
    try {
        await store.delete(); // Deleta a sessão inválida do PostgreSQL
        console.log('[FALHA DE AUTENTICAÇÃO] Sessão limpa. Por favor, reinicie o bot para escanear um novo QR Code.');
    } catch (err) {
        console.error('[FALHA DE AUTENTICAÇÃO] Erro ao limpar a sessão do DB:', err);
    }
    // Você pode querer encerrar o processo aqui para que o Render o reinicie
    // process.exit(1); 
});
client.on('error', (err) => {
    console.error('[ERRO DO CLIENTE] O cliente do WhatsApp encontrou um erro:', err);
});

client.on('disconnected', (reason) => {
    console.warn(`[DESCONECTADO] O cliente foi desconectado. Motivo: ${reason}`);
    console.log('[DESCONECTADO] Tentando reconectar automaticamente...');
    // A biblioteca tentará se reconectar automaticamente.
    // Se você notar que ele não volta, pode forçar uma reinicialização:
    client.initialize(); 
});
// ========= 3. FUNÇÃO 1: "OUVIR" (COM A CORREÇÃO) =========
client.on('message_create', async msg => {
    try {
        // <<< CORREÇÃO AQUI >>>
        // Ignora as próprias mensagens do bot (msg.fromMe), 
        // além de status e mensagens de não-usuários.
        if (msg.fromMe || msg.from === 'status@broadcast' || !msg.from.endsWith('@c.us')) {
            return; // Ignora a mensagem
        }
        // <<< FIM DA CORREÇÃO >>>

        console.log(`[OUVINDO] Mensagem recebida de ${msg.from}: "${msg.body}"`);
        
        const response = await axios.post(`${PYTHON_API_URL}/webhook-whatsapp`, 
            {
                texto: msg.body,
                numero_remetente: msg.from
            },
            { 
                headers: { 'x-api-key': API_SECRET_KEY }
            }
        );

        msg.react('👍');

        if (response.data && response.data.resposta) {
            client.sendMessage(msg.from, response.data.resposta);
        }

    } catch (error) {
        console.error("[ERRO] Falha ao processar mensagem:", error.message);
        
        if (error.response && error.response.status === 401) {
            console.warn(`[SEGURANÇA] Mensagem de ${msg.from} rejeitada pela API (Não autorizado)`);
            msg.react('🚫');
        } else {
            msg.react('❌');
        }
    }
});


// ========= 4. FUNÇÃO 2: "FALAR" (Sem Mudança) =========
app.use(express.json());
// Rota de "Health Check" E "Cron Job"
app.get('/ping', (req, res) => {
    console.log("[HEALTH CHECK] Ping recebido do UptimeRobot!");

    const dataAtual = new Date();
    // Fuso de São Paulo (UTC-3)
    const horaNoBrasil = new Date(dataAtual.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })).getHours();
    const diaNoBrasil = dataAtual.getDate(); // Pega o dia (1-31)

    // <<< LÓGICA DO CRON JOB >>>
    // Defina o horário que você quer que o motor rode (ex: 8 da manhã)
    const HORA_DE_RODAR = 8; 

    // Verifica se é a hora de rodar E se já não rodou hoje
    if (horaNoBrasil === HORA_DE_RODAR && diaNoBrasil !== ultimoDiaExecutado) {

        console.log(`[MOTOR-CRON] Detectada hora de rodar (${HORA_DE_RODAR}h)! Disparando o Cérebro Python...`);
        ultimoDiaExecutado = diaNoBrasil; // Marca que já rodou hoje

        // Chama a rota secreta no Cérebro (Python)
        axios.post(`${PYTHON_API_URL}/admin/run-motor-agendamentos`, 
            {}, // Sem corpo (body)
            { headers: { 'x-api-key': API_SECRET_KEY } } // Envia a chave secreta
        )
        .then(response => {
            console.log("[MOTOR-CRON] Cérebro processou os agendamentos com sucesso.");
        })
        .catch(error => {
            console.error("[MOTOR-CRON] ERRO ao disparar o Cérebro:", error.message);
            // Reseta o dia para tentar de novo na próxima hora 8
            ultimoDiaExecutado = null; 
        });
    }

    res.status(200).send({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========= 4. FUNÇÃO 2: "FALAR" (Versão Melhorada) =========
// ... (seu app.use(express.json()) e app.get('/ping') ficam aqui) ...

app.post('/enviar-mensagem', async (req, res) => { // 1. Adicionado 'async'
    const secret = req.headers['x-api-key'];

    // 2. Resposta de erro 401 completa
    if (secret !== API_SECRET_KEY) {
        console.warn('[FALAR] Bloqueado: Tentativa de envio com API Key errada.');
        return res.status(401).send({ status: 'erro', mensagem: 'Não autorizado' });
    }

    const { numero, mensagem } = req.body;

    // 3. Resposta de erro 400 completa
    if (!numero || !mensagem) {
        console.warn(`[FALAR] Erro 400: 'numero' ou 'mensagem' faltando no body.`);
        
        // --- AQUI ESTÁ A CORREÇÃO ---
        return res.status(400).send({ status: 'erro', mensagem: "Faltando 'numero' ou 'mensagem'" });
    }

    // Formata o ID do chat
    const chatId = numero.endsWith('@c.us') ? numero : `${numero}@c.us`;

    try {
        // 4. (MELHORIA PRINCIPAL) Verifica se o número existe no WhatsApp
        const isRegistered = await client.isRegisteredUser(chatId);
        
        if (!isRegistered) {
            console.warn(`[FALAR] Erro 404: Tentativa de enviar para número não registrado no WhatsApp: ${numero}`);
            return res.status(404).send({ status: 'erro', mensagem: 'Número não encontrado no WhatsApp.' });
        }

        // 5. Envia a mensagem com 'await' e resposta 200 completa
        await client.sendMessage(chatId, mensagem);
        console.log(`[FALAR] Mensagem enviada com sucesso para ${numero}.`);
        res.status(200).send({ status: 'sucesso', mensagem: 'Mensagem enviada.' });

    } catch (err) {
        // 6. Resposta de erro 500 completa com log
        console.error(`[FALAR] ERRO 500 ao enviar mensagem para ${numero}:`, err.message);
        res.status(500).send({ status: 'erro', mensagem: 'Falha ao enviar mensagem', detalhe: err.message });
    }
});

// ========= 5. INICIALIZAÇÃO (Sem Mudança) =========
client.initialize();
app.listen(port, () => {
    console.log(`[API DO BOT] Rodando na porta ${port}`);
});
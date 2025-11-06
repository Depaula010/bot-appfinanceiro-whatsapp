// ========= 0. IMPORTAÇÕES =========
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');

// --- NOVAS IMPORTAÇÕES PARA RemoteAuth ---
const { Pool } = require('pg'); // Driver do PostgreSQL
const { PgStore } = require('wwebjs-pg');
// --- FIM DAS NOVAS IMPORTAÇÕES ---

const app = express();
const port = process.env.PORT || 3000;
let ultimoDiaExecutado = null;

// ========= 1. CONFIGURAÇÕES =========
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

const store = new PgStore({
    pool: pool,
    sessionName: 'bot-financeiro-sessao' // Um nome único para esta sessão
});

// ========= 2. CONFIGURAÇÃO DO BOT WHATSAPP (COM RemoteAuth) =========
console.log("Iniciando cliente do WhatsApp com RemoteAuth (PostgreSQL)...");
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

client.on('qr', qr => { /* ... (código do QR) ... */ 
    console.log("========================================");
    console.log("LOGIN NECESSÁRIO: Escaneie com o celular que será o BOT:");
    qrcode.generate(qr, { small: true });
    console.log("========================================");
});
client.on('ready', () => { /* ... (código de pronto) ... */ 
    console.log('*** BOT ESTÁ PRONTO E CONECTADO! ***');
});
client.on('auth_failure', (msg) => { /* ... (código de falha) ... */ });
client.on('error', (err) => { /* ... (código de erro) ... */ });
client.on('disconnected', (reason) => { /* ... (código de desconectado) ... */ });

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
app.post('/enviar-mensagem', (req, res) => {
    // ... (Todo o código do /enviar-mensagem continua igual) ...
    const secret = req.headers['x-api-key'];
    if (secret !== API_SECRET_KEY) { /* ... (erro 401) ... */ }
    const { numero, mensagem } = req.body;
    if (!numero || !mensagem) { /* ... (erro 400) ... */ }
    const chatId = numero.endsWith('@c.us') ? numero : `${numero}@c.us`;
    client.sendMessage(chatId, mensagem).then(() => { /* ... (sucesso 200) ... */ }).catch(err => { /* ... (erro 500) ... */ });
});

// ========= 5. INICIALIZAÇÃO (Sem Mudança) =========
client.initialize();
app.listen(port, () => {
    console.log(`[API DO BOT] Rodando na porta ${port}`);
});
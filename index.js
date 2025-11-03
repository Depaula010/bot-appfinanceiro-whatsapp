// ========= 0. IMPORTAÇÕES =========
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// ========= 1. CONFIGURAÇÕES =========
const PYTHON_API_URL = 'https://app-controle-financeiro-oh32.onrender.com';
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'uma-senha-bem-forte-12345';

// ========= 2. CONFIGURAÇÃO DO BOT WHATSAPP (Sem Mudança) =========
console.log("Iniciando cliente do WhatsApp...");
const client = new Client({
    authStrategy: new LocalAuth(),
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
app.get('/ping', (req, res) => {
    console.log("[HEALTH CHECK] Ping recebido do UptimeRobot!");
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
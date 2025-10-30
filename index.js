// ========= 0. IMPORTAÇÕES =========
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// ========= 1. CONFIGURAÇÕES (EDITAR!) =========
const PYTHON_API_URL = 'https://app-controle-financeiro-oh32.onrender.com';
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'uma-senha-bem-forte-12345';

// ========= 2. CONFIGURAÇÃO DO BOT WHATSAPP (COM SESSÃO SALVA) =========
console.log("Iniciando cliente do WhatsApp...");
const client = new Client({
    // Voltamos a usar a LocalAuth padrão, pois não temos disco
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});
// ... (Todo o código de client.on('qr'), client.on('ready'), etc. continua igual) ...
client.on('qr', qr => { /* ... (código do QR) ... */ 
    console.log("========================================");
    console.log("LOGIN NECESSÁRIO: Escaneie com o celular que será o BOT:");
    qrcode.generate(qr, { small: true });
    console.log("========================================");
});
client.on('ready', () => { /* ... (código de pronto) ... */ 
    console.log('*** BOT ESTÁ PRONTO E CONECTADO! ***');
});
client.on('error', (err) => { /* ... (código de erro) ... */ });
client.on('disconnected', (reason) => { /* ... (código de desconectado) ... */ });
client.on('message_create', async msg => { /* ... (código de "Ouvir") ... */ });


// ========= 4. FUNÇÃO 2: "FALAR COM VOCÊ" (API para o Cérebro) =========
app.use(express.json());

// Rota de "Health Check" (para o UptimeRobot)
app.get('/ping', (req, res) => {
    console.log("[HEALTH CHECK] Ping recebido!");
    res.status(200).send({ status: 'ok', timestamp: new Date().toISOString() });
});

// Endpoint: /enviar-mensagem
app.post('/enviar-mensagem', (req, res) => {
    // ... (Todo o código do /enviar-mensagem continua igual) ...
    const secret = req.headers['x-api-key'];
    if (secret !== API_SECRET_KEY) { /* ... (erro 401) ... */ }
    const { numero, mensagem } = req.body;
    if (!numero || !mensagem) { /* ... (erro 400) ... */ }
    const chatId = numero.endsWith('@c.us') ? numero : `${numero}@c.us`;
    client.sendMessage(chatId, mensagem).then(() => { /* ... (sucesso 200) ... */ }).catch(err => { /* ... (erro 500) ... */ });
});


// ========= 5. INICIALIZAÇÃO =========
client.initialize();
app.listen(port, () => {
    console.log(`[API DO BOT] Rodando na porta ${port}`);
});
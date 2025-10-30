// ========= 0. IMPORTAÇÕES =========
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000; // Porta para o Render

// ========= 1. CONFIGURAÇÕES (EDITAR!) =========

// <<< 1. EDITAR AQUI >>>
// A URL da sua API Python (o "Cérebro" no Render)
const PYTHON_API_URL = 'https://app-controle-financeiro-oh32.onrender.com';

// <<< 2. EDITAR AQUI >>>
// Crie uma senha secreta. 
// (Vamos usar esta senha no Render depois para o Python falar com o Bot)
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'uma-senha-bem-forte-12345';


// ========= 2. CONFIGURAÇÃO DO BOT WHATSAPP (COM SESSÃO SALVA) =========

console.log("Iniciando cliente do WhatsApp...");
const client = new Client({
    // É ISSO AQUI QUE SALVA A SESSÃO:
    authStrategy: new LocalAuth({ dataPath: "/data/whatsapp-session" }),
    
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'], // Obrigatório para o Render
    }
});

// Gera o QR Code (APENAS NA PRIMEIRA VEZ)
client.on('qr', qr => {
    console.log("========================================");
    console.log("PRIMEIRO LOGIN: Escaneie com o celular que será o BOT:");
    qrcode.generate(qr, { small: true });
    console.log("========================================");
});

client.on('ready', () => {
    console.log('*** BOT ESTÁ PRONTO E CONECTADO! ***');
});

client.on('auth_failure', (msg) => {
    console.error('[ERRO] Falha na autenticação!', msg);
    // (Aqui pode precisar limpar a pasta .wwebjs_auth se a sessão corromper)
});

client.on('error', (err) => {
    console.error('[ERRO] Erro no Cliente WhatsApp:', err);
});

client.on('disconnected', (reason) => {
    console.warn('[AVISO] Cliente desconectado!', reason);
    console.log('Tentando reconectar em 10 segundos...');
    setTimeout(() => {
        client.initialize();
    }, 10000); // Tenta reconectar a cada 10s
});


// ========= 3. FUNÇÃO 1: "OUVIR" MENSAGENS =========
// (Ouve todas as mensagens e envia para o Cérebro Python)
client.on('message_create', async msg => {
    try {
        // Ignora mensagens de status, grupos, etc.
        if (msg.from === 'status@broadcast' || !msg.from.endsWith('@c.us')) {
            return;
        }

        console.log(`[OUVINDO] Mensagem recebida de ${msg.from}: "${msg.body}"`);
        
        // Envia o texto E O NÚMERO DO REMETENTE para a API Python
        // O app.py (Cérebro) será o responsável por verificar se o usuário é autorizado
        const response = await axios.post(`${PYTHON_API_URL}/webhook-whatsapp`, 
            {
                texto: msg.body,
                numero_remetente: msg.from // Envia o número para a API checar
            },
            { 
                headers: { 'x-api-key': API_SECRET_KEY }
            }
        );

        // Se o Cérebro (Python) processar e responder "sucesso"...
        msg.react('👍');

        // Se o Cérebro (Python) mandar uma resposta em texto...
        if (response.data && response.data.resposta) {
            client.sendMessage(msg.from, response.data.resposta);
        }

    } catch (error) {
        // Se a API Python (Cérebro) der erro (ex: 401 Não Autorizado ou 500)
        console.error("[ERRO] Falha ao enviar para API Python:", error.message);
        
        if (error.response && error.response.status === 401) {
            console.warn(`[SEGURANÇA] Mensagem de ${msg.from} rejeitada pela API (Não autorizado)`);
            msg.react('🚫'); // Reage com "proibido"
        } else {
            msg.react('❌'); // Reage com "erro"
        }
    }
});


// ========= 4. FUNÇÃO 2: "FALAR" (API para o Cérebro) =========
// (Cria um servidor 'express' para o Cérebro Python chamar)
app.use(express.json());

// Endpoint: /enviar-mensagem
app.post('/enviar-mensagem', (req, res) => {
    
    const secret = req.headers['x-api-key'];
    if (secret !== API_SECRET_KEY) {
        console.warn("[ALERTA] Tentativa de /enviar-mensagem com chave errada!");
        return res.status(401).send('Chave de API inválida.');
    }

    const { numero, mensagem } = req.body;
    if (!numero || !mensagem) {
        return res.status(400).send('Faltando "numero" ou "mensagem".');
    }
    
    const chatId = numero.endsWith('@c.us') ? numero : `${numero}@c.us`;

    client.sendMessage(chatId, mensagem).then(() => {
        console.log(`[FALANDO] Mensagem enviada para ${chatId}.`);
        res.status(200).send({ status: 'sucesso', msg: 'Mensagem enviada.' });
    }).catch(err => {
        console.error("[ERRO] Falha ao enviar mensagem:", err);
        res.status(500).send({ status: 'erro', msg: 'Falha ao enviar mensagem.' });
    });
});


// ========= 5. INICIALIZAÇÃO =========
client.initialize();
app.listen(port, () => {
    console.log(`[API DO BOT] Função "Falar" rodando na porta ${port}`);
});
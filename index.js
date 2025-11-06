// ========= 0. IMPORTAÇÕES =========
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    DisconnectReason,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { PgStore } = require('@whiskeysockets/baileys-pg-store');
const { Pool } = require('pg');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');

// ========= 1. CONFIGURAÇÕES =========
const app = express();
const port = process.env.PORT || 3000;
let ultimoDiaExecutado = null;

const ADMIN_WHATSAPP_NUMBER = process.env.ADMIN_WHATSAPP_NUMBER;
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'uma-senha-bem-forte-12345';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("ERRO CRÍTICO: Variável de ambiente DATABASE_URL não definida.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
});

// Configura o Store de Autenticação do Baileys
const authStore = new PgStore(pool, {
    cleanupInterval: 30, // Intervalo (em dias) para limpar dados antigos
    maxRetries: 10
});

// O socket (cliente) do Baileys, global para ser usado pelo Express
let sock;
let logger = pino({ level: 'warn' }); // Nível 'warn' para não poluir os logs do Render

// ========= 2. FUNÇÃO PRINCIPAL DO BOT (BAILEYS) =========
async function connectToWhatsApp() {
    console.log("Iniciando conexão com o WhatsApp (Baileys)...");
    
    // Pega o estado salvo (auth) do banco de dados
    const { state, saveCreds } = await authStore.useAuth('baileys_session_auth');

    const { version } = await fetchLatestBaileysVersion();
    console.log(`Usando WA v${version.join('.')}`);

    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false, // Vamos imprimir manualmente
        auth: state
    });

    // Evento: Atualização da Conexão (QR Code, Conectado, Desconectado)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("========================================");
            console.log("LOGIN NECESSÁRIO: Escaneie com o celular que será o BOT:");
            qrcode.generate(qr, { small: true });
            console.log("========================================");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.warn(`[CONEXÃO] Conexão fechada. Motivo: ${lastDisconnect.error?.message}. Reconectando: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.error("[CONEXÃO] Logout detectado. Limpe a tabela 'baileys_auth_store' e reinicie.");
            }
        } else if (connection === 'open') {
            console.log('*** BOT ESTÁ PRONTO E CONECTADO! ***');
            
            // --- Notificação de Startup para o Admin (Mesma lógica de antes) ---
            const adminChatId = `${ADMIN_WHATSAPP_NUMBER}@s.whatsapp.net`;
            const fusoHorarioSP = { timeZone: 'America/Sao_Paulo' };
            const dataFormatada = new Date().toLocaleString('pt-BR', fusoHorarioSP);
            const startupMessage = `✅ *Bot Financeiro (Online - Baileys)*\n\nServiço reiniciado e conectado com sucesso.\n\n*Horário:* ${dataFormatada}`;
            
            setTimeout(() => {
                sock.sendMessage(adminChatId, { text: startupMessage })
                    .then(() => console.log("[STARTUP] Notificação de 'Bot Online' enviada para o admin."))
                    .catch((err) => console.error("[STARTUP] Falha ao enviar notificação para o admin.", err));
            }, 10000); // 10s de delay
        }
    });

    // Evento: Salvando Credenciais (quando o estado muda)
    sock.ev.on('creds.update', saveCreds);

    // Evento: Mensagem Recebida (FUNÇÃO 1: "OUVIR")
    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.messages.length === 0) return;
        
        const msg = m.messages[0];
        
        // Ignora mensagens de broadcast, sem texto, ou do próprio bot
        if (!msg.message || msg.key.fromMe || !msg.key.remoteJid || !msg.message.conversation) {
            return;
        }

        // Formata o ID do remetente
        const from = msg.key.remoteJid;
        const fromNumber = jidNormalizedUser(from);
        const msgBody = msg.message.conversation;

        try {
            console.log(`[OUVINDO] Mensagem recebida de ${fromNumber}: "${msgBody}"`);
            
            const response = await axios.post(`${PYTHON_API_URL}/webhook-whatsapp`, 
                {
                    texto: msgBody,
                    numero_remetente: fromNumber // Envia só o número
                },
                { 
                    headers: { 'x-api-key': API_SECRET_KEY }
                }
            );

            // Reage à mensagem original (Baileys)
            await sock.sendMessage(from, {
                react: { text: '👍', key: msg.key }
            });

            if (response.data && response.data.resposta) {
                // Envia a resposta (Baileys)
                await sock.sendMessage(from, { text: response.data.resposta });
            }

        } catch (error) {
            console.error("[ERRO] Falha ao processar mensagem:", error.message);
            
            await sock.sendMessage(from, {
                react: { text: '❌', key: msg.key }
            });
        }
    });
}

// ========= 3. SERVIDOR EXPRESS (FUNÇÃO 2: "FALAR" E "PING-CRON") =========
app.use(express.json());

// Rota de "Health Check" E "Cron Job" (Sem mudanças na lógica)
app.get('/ping', (req, res) => {
    console.log("[HEALTH CHECK] Ping recebido do UptimeRobot!");

    const dataAtual = new Date();
    const horaNoBrasil = new Date(dataAtual.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })).getHours();
    const diaNoBrasil = dataAtual.getDate();
    const HORA_DE_RODAR = 8; 

    if (horaNoBrasil === HORA_DE_RODAR && diaNoBrasil !== ultimoDiaExecutado) {
        console.log(`[MOTOR-CRON] Detectada hora de rodar (${HORA_DE_RODAR}h)! Disparando o Cérebro Python...`);
        ultimoDiaExecutado = diaNoBrasil; 

        axios.post(`${PYTHON_API_URL}/admin/run-motor-agendamentos`, 
            {}, 
            { headers: { 'x-api-key': API_SECRET_KEY } }
        )
        .then(response => {
            console.log("[MOTOR-CRON] Cérebro processou os agendamentos com sucesso.");
        })
        .catch(error => {
            console.error("[MOTOR-CRON] ERRO ao disparar o Cérebro:", error.message);
            ultimoDiaExecutado = null; 
        });
    }
    res.status(200).send({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rota para o Python enviar mensagens (FUNÇÃO 2: "FALAR", adaptada para Baileys)
app.post('/enviar-mensagem', async (req, res) => {
    const secret = req.headers['x-api-key'];

    if (secret !== API_SECRET_KEY) {
        console.warn('[FALAR] Bloqueado: Tentativa de envio com API Key errada.');
        return res.status(401).send({ status: 'erro', mensagem: 'Não autorizado' });
    }

    const { numero, mensagem } = req.body;

    if (!numero || !mensagem) {
        console.warn(`[FALAR] Erro 400: 'numero' ou 'mensagem' faltando no body.`);
        return res.status(400).send({ status: 'erro', mensagem: "Faltando 'numero' ou 'mensagem'" });
    }

    // Garante que o 'sock' está pronto
    if (!sock || sock.user.id === undefined) {
         console.warn(`[FALAR] Erro 503: Bot (Baileys) ainda não está conectado.`);
        return res.status(503).send({ status: 'erro', mensagem: 'Bot não está pronto.' });
    }

    try {
        // Formata o ID do chat para Baileys (ex: 553194001072@s.whatsapp.net)
        const chatId = `${numero}@s.whatsapp.net`;

        // (MELHORIA) Verifica se o número existe no WhatsApp (Baileys)
        const [result] = await sock.onWhatsApp(chatId);
        
        if (!result || !result.exists) {
            console.warn(`[FALAR] Erro 404: Tentativa de enviar para número não registrado: ${numero}`);
            return res.status(404).send({ status: 'erro', mensagem: 'Número não encontrado no WhatsApp.' });
        }

        // Envia a mensagem (Baileys)
        await sock.sendMessage(chatId, { text: mensagem });
        console.log(`[FALAR] Mensagem enviada com sucesso para ${numero}.`);
        res.status(200).send({ status: 'sucesso', mensagem: 'Mensagem enviada.' });

    } catch (err) {
        console.error(`[FALAR] ERRO 500 ao enviar mensagem para ${numero}:`, err.message);
        res.status(500).send({ status: 'erro', mensagem: 'Falha ao enviar mensagem', detalhe: err.message });
    }
});

// ========= 4. INICIALIZAÇÃO =========
// Inicia o bot
connectToWhatsApp();
// Inicia o servidor web
app.listen(port, () => {
    console.log(`[API DO BOT] Rodando na porta ${port}`);
});
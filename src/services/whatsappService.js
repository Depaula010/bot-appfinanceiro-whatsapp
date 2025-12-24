// ========================================
// WhatsApp Service - Operações Auxiliares
// ========================================
// Funções auxiliares e validações relacionadas ao WhatsApp

const qrcode = require('qrcode-terminal');
const { formatarChatId, validarNumeroWhatsApp, limparNumero } = require('../utils/formatting');

/**
 * Gera QR code em formato terminal (para debugging)
 * @param {string} qr - String do QR code
 */
function printQRToTerminal(qr) {
    qrcode.generate(qr, { small: true });
}

/**
 * Converte QR code string para data URL (base64)
 * Útil para enviar QR code em resposta JSON
 * @param {string} qr - String do QR code
 * @returns {Promise<string>} Data URL do QR code
 */
async function qrToDataURL(qr) {
    const QRCode = require('qrcode');
    return QRCode.toDataURL(qr);
}

/**
 * Valida lista de números de telefone
 * @param {Array<string>} numeros - Lista de números
 * @returns {Object} { valid: [], invalid: [] }
 */
function validarListaNumeros(numeros) {
    const valid = [];
    const invalid = [];

    for (const numero of numeros) {
        if (validarNumeroWhatsApp(numero)) {
            valid.push(limparNumero(numero));
        } else {
            invalid.push(numero);
        }
    }

    return { valid, invalid };
}

/**
 * Formata mensagem com template básico
 * @param {string} template - Template com placeholders {variavel}
 * @param {Object} vars - Variáveis para substituir
 * @returns {string} Mensagem formatada
 */
function formatarMensagem(template, vars = {}) {
    let mensagem = template;

    for (const [key, value] of Object.entries(vars)) {
        const placeholder = new RegExp(`{${key}}`, 'g');
        mensagem = mensagem.replace(placeholder, value);
    }

    return mensagem;
}

/**
 * Extrai tipo de mídia de um buffer
 * @param {Buffer} buffer - Buffer da mídia
 * @returns {string|null} Tipo MIME ou null
 */
function detectarTipoMidia(buffer) {
    // Detectar por magic numbers
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return 'image/png';
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        return 'image/gif';
    }
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
        return 'application/pdf';
    }

    return null;
}

/**
 * Valida se buffer é uma imagem válida
 * @param {Buffer} buffer - Buffer para validar
 * @returns {boolean} true se é imagem válida
 */
function validarImagem(buffer) {
    const tipo = detectarTipoMidia(buffer);
    return tipo && tipo.startsWith('image/');
}

/**
 * Converte base64 para buffer
 * @param {string} base64String - String em base64
 * @returns {Buffer} Buffer da imagem
 */
function base64ToBuffer(base64String) {
    // Remover prefixo data URL se presente
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(base64Data, 'base64');
}

/**
 * Sanitiza texto para envio (remove caracteres problemáticos)
 * @param {string} texto - Texto para sanitizar
 * @returns {string} Texto sanitizado
 */
function sanitizarTexto(texto) {
    return texto
        .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, '') // Remove controle characters
        .trim();
}

/**
 * Trunca mensagem longa (WhatsApp tem limite de caracteres)
 * @param {string} texto - Texto para truncar
 * @param {number} maxLength - Tamanho máximo (padrão 4096)
 * @returns {string} Texto truncado
 */
function truncarMensagem(texto, maxLength = 4096) {
    if (texto.length <= maxLength) {
        return texto;
    }

    return texto.substring(0, maxLength - 3) + '...';
}

/**
 * Formata número para exibição internacional
 * @param {string} numero - Número em formato limpo
 * @returns {string} Número formatado (+55 11 99999-8888)
 */
function formatarNumeroInternacional(numero) {
    const numeroLimpo = limparNumero(numero);

    // Formato brasileiro
    if (numeroLimpo.startsWith('55') && numeroLimpo.length >= 12) {
        const codigoPais = numeroLimpo.substring(0, 2);
        const ddd = numeroLimpo.substring(2, 4);
        const parte1 = numeroLimpo.substring(4, numeroLimpo.length - 4);
        const parte2 = numeroLimpo.substring(numeroLimpo.length - 4);

        return `+${codigoPais} (${ddd}) ${parte1}-${parte2}`;
    }

    // Formato genérico
    return `+${numeroLimpo}`;
}

/**
 * Valida se string é um UUID válido
 * @param {string} str - String para validar
 * @returns {boolean} true se é UUID válido
 */
function isValidUUID(str) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
}

/**
 * Parseia tempo de espera para retry exponencial
 * @param {number} attempt - Número da tentativa
 * @param {number} baseDelay - Delay base em ms (padrão 1000)
 * @param {number} maxDelay - Delay máximo em ms (padrão 30000)
 * @returns {number} Tempo de espera em ms
 */
function calcularRetryDelay(attempt, baseDelay = 1000, maxDelay = 30000) {
    const delay = baseDelay * Math.pow(2, attempt - 1);
    return Math.min(delay, maxDelay);
}

module.exports = {
    printQRToTerminal,
    qrToDataURL,
    validarListaNumeros,
    formatarMensagem,
    detectarTipoMidia,
    validarImagem,
    base64ToBuffer,
    sanitizarTexto,
    truncarMensagem,
    formatarNumeroInternacional,
    isValidUUID,
    calcularRetryDelay
};

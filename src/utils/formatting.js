// ========================================
// Utilitários de Formatação
// ========================================
// Formatação de números de telefone WhatsApp

/**
 * Formata número de telefone para o formato WhatsApp (chatId)
 * @param {string} numero - Número de telefone (com ou sem código do país)
 * @returns {string} Número formatado para WhatsApp (ex: 5511999998888@s.whatsapp.net)
 */
function formatarChatId(numero) {
    // Remove todos os caracteres não-numéricos
    const numeroLimpo = numero.replace(/\D/g, '');

    // Se já contém @, retorna como está
    if (numero.includes('@')) {
        return numero;
    }

    // Adiciona sufixo do WhatsApp
    return `${numeroLimpo}@s.whatsapp.net`;
}

/**
 * Extrai apenas os números de um telefone
 * @param {string} numero - Número com ou sem formatação
 * @returns {string} Apenas dígitos
 */
function limparNumero(numero) {
    return numero.replace(/\D/g, '');
}

/**
 * Remove o sufixo @s.whatsapp.net de um chatId
 * @param {string} chatId - ID do chat WhatsApp
 * @returns {string} Número sem sufixo
 */
function extrairNumero(chatId) {
    return chatId.replace('@s.whatsapp.net', '').replace('@c.us', '');
}

/**
 * Valida se um número está no formato correto do WhatsApp
 * @param {string} numero - Número para validar
 * @returns {boolean} true se válido
 */
function validarNumeroWhatsApp(numero) {
    const numeroLimpo = limparNumero(numero);

    // Número deve ter entre 10 e 15 dígitos (padrão internacional)
    if (numeroLimpo.length < 10 || numeroLimpo.length > 15) {
        return false;
    }

    // Deve conter apenas dígitos
    return /^\d+$/.test(numeroLimpo);
}

/**
 * Normaliza número para formato padrão brasileiro (55XXYYYYYYYY)
 * @param {string} numero - Número para normalizar
 * @returns {string|null} Número normalizado ou null se inválido
 */
function normalizarNumeroBR(numero) {
    let numeroLimpo = limparNumero(numero);

    // Se não tem código do país, adiciona +55 (Brasil)
    if (numeroLimpo.length === 11 || numeroLimpo.length === 10) {
        numeroLimpo = '55' + numeroLimpo;
    }

    // Validar formato brasileiro: 55 + DDD (2 dígitos) + número (8 ou 9 dígitos)
    if (!/^55\d{10,11}$/.test(numeroLimpo)) {
        return null;
    }

    return numeroLimpo;
}

/**
 * Formata número para exibição (55 11 99999-8888)
 * @param {string} numero - Número para formatar
 * @returns {string} Número formatado para leitura
 */
function formatarParaExibicao(numero) {
    const numeroLimpo = limparNumero(numero);

    // Formato brasileiro com código do país
    if (numeroLimpo.startsWith('55') && numeroLimpo.length >= 12) {
        const codigoPais = numeroLimpo.substring(0, 2);
        const ddd = numeroLimpo.substring(2, 4);
        const parte1 = numeroLimpo.substring(4, numeroLimpo.length - 4);
        const parte2 = numeroLimpo.substring(numeroLimpo.length - 4);

        return `+${codigoPais} ${ddd} ${parte1}-${parte2}`;
    }

    // Formato genérico
    return numeroLimpo;
}

/**
 * Verifica se um JID é de grupo
 * @param {string} jid - JID do WhatsApp
 * @returns {boolean} true se for grupo
 */
function isGrupo(jid) {
    return jid.includes('@g.us');
}

/**
 * Verifica se um JID é de broadcast (status)
 * @param {string} jid - JID do WhatsApp
 * @returns {boolean} true se for broadcast/status
 */
function isBroadcast(jid) {
    return jid === 'status@broadcast';
}

module.exports = {
    formatarChatId,
    limparNumero,
    extrairNumero,
    validarNumeroWhatsApp,
    normalizarNumeroBR,
    formatarParaExibicao,
    isGrupo,
    isBroadcast
};

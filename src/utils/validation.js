// ========================================
// Validação de URLs e Inputs
// ========================================

/**
 * Valida webhook URL para prevenir SSRF
 * Bloqueia IPs privados e protocolos inseguros
 * @param {string} url - URL para validar
 * @returns {boolean} true se URL é segura
 */
function validateWebhookUrl(url) {
    try {
        const parsed = new URL(url);

        // Apenas HTTP/HTTPS permitidos
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return false;
        }

        const hostname = parsed.hostname;

        // Bloquear IPs privados e reservados
        const blockedPatterns = [
            /^127\./,                          // Loopback
            /^10\./,                           // Classe A privado
            /^172\.(1[6-9]|2[0-9]|3[01])\./,  // Classe B privado
            /^192\.168\./,                     // Classe C privado
            /^169\.254\./,                     // Link-local
            /^0\./,                            // Rede zero
            /^::1$/,                           // IPv6 loopback
            /^fc00:/i,                         // IPv6 privado
            /^fe80:/i,                         // IPv6 link-local
            /^localhost$/i,                    // localhost
        ];

        for (const pattern of blockedPatterns) {
            if (pattern.test(hostname)) {
                return false;
            }
        }

        return true;
    } catch {
        return false;
    }
}

module.exports = {
    validateWebhookUrl
};

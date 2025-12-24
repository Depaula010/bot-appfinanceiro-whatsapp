-- ========================================
-- MIGRATION 002: Create Sessions Table
-- ========================================
-- Este arquivo cria a tabela de sessões WhatsApp e modifica baileys_auth

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_name VARCHAR(100) UNIQUE NOT NULL,
    api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    webhook_url TEXT NOT NULL,
    webhook_signature_key VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connecting', 'connected', 'failed')),
    phone_number VARCHAR(50),
    qr_code TEXT,
    qr_expires_at TIMESTAMPTZ,
    last_connected_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_sessions_api_key ON sessions(api_key_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(session_name);

-- Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Modificar tabela baileys_auth para suportar múltiplas sessões
ALTER TABLE baileys_auth ADD COLUMN IF NOT EXISTS session_uuid UUID;
ALTER TABLE baileys_auth DROP CONSTRAINT IF EXISTS fk_session;
ALTER TABLE baileys_auth ADD CONSTRAINT fk_session
    FOREIGN KEY (session_uuid) REFERENCES sessions(id) ON DELETE CASCADE;

-- Comentários
COMMENT ON TABLE sessions IS 'Armazena configurações e status de sessões WhatsApp';
COMMENT ON COLUMN sessions.session_name IS 'Nome único da sessão (ex: cliente-production)';
COMMENT ON COLUMN sessions.webhook_url IS 'URL para envio de mensagens recebidas';
COMMENT ON COLUMN sessions.webhook_signature_key IS 'Chave HMAC para assinatura de webhooks';
COMMENT ON COLUMN sessions.qr_code IS 'QR code em base64 para autenticação';
COMMENT ON COLUMN sessions.metadata IS 'Dados adicionais personalizados (JSON)';

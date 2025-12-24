-- ========================================
-- MIGRATION 001: Create API Keys Table
-- ========================================
-- Este arquivo cria a tabela de API keys para autenticação multi-projeto

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash VARCHAR(255) UNIQUE NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,
    project_name VARCHAR(100) NOT NULL,
    description TEXT,
    rate_limit_per_minute INTEGER DEFAULT 60,
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

-- Comentários
COMMENT ON TABLE api_keys IS 'Armazena API keys para autenticação de projetos/clientes';
COMMENT ON COLUMN api_keys.key_hash IS 'Hash bcrypt da API key (nunca armazenar em plaintext)';
COMMENT ON COLUMN api_keys.key_prefix IS 'Primeiros 16 caracteres da key para lookup rápido';
COMMENT ON COLUMN api_keys.rate_limit_per_minute IS 'Limite de requisições por minuto';

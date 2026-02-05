-- ========================================
-- MIGRATION 004: Fix baileys_auth unique constraint
-- ========================================
-- Adiciona UNIQUE constraint em (session_uuid, data_key) que é necessário
-- para o ON CONFLICT funcionar no authState.js

-- Criar unique constraint para suportar ON CONFLICT (session_uuid, data_key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_baileys_auth_session_uuid_data_key
    ON baileys_auth (session_uuid, data_key);

-- ========================================
-- MIGRATION 003: Create Session Logs Table
-- ========================================
-- Este arquivo cria a tabela de logs de eventos das sessões

CREATE TABLE IF NOT EXISTS session_logs (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_logs_event_type ON session_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_session_logs_created_at ON session_logs(created_at);

-- Particionamento automático por data (opcional, para volumes altos)
-- Descomente se necessário performance em alto volume
-- CREATE TABLE session_logs_2025_01 PARTITION OF session_logs
--     FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

-- Função para limpeza automática de logs antigos (manter últimos 90 dias)
CREATE OR REPLACE FUNCTION cleanup_old_session_logs()
RETURNS void AS $$
BEGIN
    DELETE FROM session_logs WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Comentários
COMMENT ON TABLE session_logs IS 'Log de eventos das sessões WhatsApp para auditoria e troubleshooting';
COMMENT ON COLUMN session_logs.event_type IS 'Tipo de evento: qr_generated, connected, disconnected, message_sent, message_received, webhook_error, etc';
COMMENT ON COLUMN session_logs.details IS 'Detalhes do evento em formato JSON';

-- Tipos de eventos comuns:
-- - qr_generated: QR code foi gerado
-- - connected: Sessão conectou com sucesso
-- - disconnected: Sessão desconectou
-- - message_sent: Mensagem enviada
-- - message_received: Mensagem recebida
-- - webhook_error: Erro ao enviar webhook
-- - error: Erro genérico

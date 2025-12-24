# WhatsApp Bot API - Documentação

## Visão Geral

API REST para gerenciamento de múltiplas sessões WhatsApp com isolamento completo entre projetos.

**Base URL**: `https://seu-dominio.com`
**Versão**: v1
**Autenticação**: API Key via header `X-API-Key`

## Autenticação

### API Keys

Todas as requisições (exceto endpoints administrativos) requerem uma API key no header:

```http
X-API-Key: whatsapp_live_Kj8mN3pQ9rT2vW5xY7zA1bC4dE6fG8hI
```

### Admin Key

Endpoints administrativos requerem a chave de admin:

```http
X-Admin-Key: sua_chave_admin
```

## Endpoints

### Sessões

#### Criar Sessão

```http
POST /api/v1/sessions
```

**Headers**:
- `X-API-Key`: Sua API key
- `Content-Type`: application/json

**Body**:
```json
{
  "session_name": "meu-projeto-production",
  "webhook_url": "https://seu-backend.com/webhook/whatsapp",
  "webhook_signature_key": "chave_secreta_hmac",
  "metadata": {
    "client_id": "123",
    "environment": "production"
  }
}
```

**Resposta** (201):
```json
{
  "status": "success",
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "session_name": "meu-projeto-production",
    "status": "disconnected",
    "webhook_url": "https://seu-backend.com/webhook/whatsapp",
    "created_at": "2025-01-15T10:00:00Z"
  }
}
```

#### Listar Sessões

```http
GET /api/v1/sessions
```

**Resposta**:
```json
{
  "status": "success",
  "data": [
    {
      "session_id": "550e8400-e29b-41d4-a716-446655440000",
      "session_name": "meu-projeto-production",
      "status": "connected",
      "phone_number": "5511999998888",
      "last_connected_at": "2025-01-15T10:30:00Z",
      "created_at": "2025-01-15T10:00:00Z"
    }
  ],
  "count": 1
}
```

#### Obter Detalhes da Sessão

```http
GET /api/v1/sessions/:session_id
```

**Resposta**:
```json
{
  "status": "success",
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "session_name": "meu-projeto-production",
    "status": "connected",
    "phone_number": "5511999998888",
    "webhook_url": "https://seu-backend.com/webhook/whatsapp",
    "last_connected_at": "2025-01-15T10:30:00Z",
    "created_at": "2025-01-15T10:00:00Z",
    "updated_at": "2025-01-15T10:30:00Z",
    "is_active": true,
    "metadata": {}
  }
}
```

#### Iniciar Conexão

```http
POST /api/v1/sessions/:session_id/connect
```

**Resposta**:
```json
{
  "status": "success",
  "message": "Connection initiated. Poll /qr endpoint for QR code.",
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "connecting"
  }
}
```

#### Obter QR Code

```http
GET /api/v1/sessions/:session_id/qr
```

**Uso**: Poll este endpoint a cada 2-3 segundos após iniciar conexão.

**Resposta** (quando QR disponível):
```json
{
  "status": "success",
  "data": {
    "qr_code": "data:image/png;base64,iVBORw0KGgoAAAANS...",
    "expires_at": "2025-01-15T10:05:00Z",
    "session_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Resposta** (já conectado):
```json
{
  "status": "success",
  "message": "Session already connected",
  "data": {
    "status": "connected",
    "phone_number": "5511999998888"
  }
}
```

#### Desconectar Sessão

```http
POST /api/v1/sessions/:session_id/disconnect
```

**Resposta**:
```json
{
  "status": "success",
  "message": "Session disconnected successfully",
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "disconnected"
  }
}
```

#### Deletar Sessão

```http
DELETE /api/v1/sessions/:session_id
```

**Resposta**:
```json
{
  "status": "success",
  "message": "Session deleted successfully",
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

#### Obter Logs da Sessão

```http
GET /api/v1/sessions/:session_id/logs?limit=50&offset=0
```

**Resposta**:
```json
{
  "status": "success",
  "data": [
    {
      "id": 1,
      "event_type": "message_sent",
      "details": {
        "to": "5511999998888",
        "message_id": "3EB0..."
      },
      "created_at": "2025-01-15T10:35:00Z"
    }
  ],
  "count": 1
}
```

### Mensagens

#### Enviar Mensagem

```http
POST /api/v1/sessions/:session_id/send-message
```

**Body**:
```json
{
  "numero": "5511999998888",
  "mensagem": "Olá, tudo bem?"
}
```

**Resposta**:
```json
{
  "status": "sucesso",
  "mensagem": "Mensagem enviada com sucesso.",
  "data": {
    "message_id": "3EB0...",
    "to": "5511999998888",
    "timestamp": "2025-01-15T10:40:00Z"
  }
}
```

#### Enviar Imagem

```http
POST /api/v1/sessions/:session_id/send-image
```

**Body**:
```json
{
  "numero": "5511999998888",
  "imagem": "data:image/png;base64,iVBORw0KGgo...",
  "legenda": "Veja esta imagem!"
}
```

**Resposta**:
```json
{
  "status": "sucesso",
  "mensagem": "Imagem enviada com sucesso.",
  "data": {
    "message_id": "3EB0...",
    "to": "5511999998888",
    "timestamp": "2025-01-15T10:41:00Z"
  }
}
```

#### Envio em Massa (Broadcast)

```http
POST /api/v1/sessions/:session_id/send-bulk
```

**Body**:
```json
{
  "numeros": ["5511999998888", "5511988887777"],
  "mensagem": "Mensagem em massa"
}
```

**Resposta**:
```json
{
  "status": "success",
  "message": "Bulk send completed",
  "data": {
    "total": 2,
    "sent": 2,
    "failed": 0,
    "invalid": 0,
    "results": [
      {
        "numero": "5511999998888",
        "status": "success",
        "message_id": "3EB0..."
      }
    ],
    "invalid_numbers": []
  }
}
```

### Admin

#### Criar API Key

```http
POST /api/v1/admin/api-keys
```

**Headers**:
- `X-Admin-Key`: Chave de admin

**Body**:
```json
{
  "project_name": "Cliente ABC",
  "description": "Ambiente de produção",
  "rate_limit_per_minute": 100,
  "expires_at": "2026-01-15T00:00:00Z",
  "environment": "live"
}
```

**Resposta**:
```json
{
  "status": "success",
  "message": "API key created successfully",
  "data": {
    "api_key": "whatsapp_live_Kj8mN3pQ9rT2vW5xY7zA1bC4dE6fG8hI",
    "api_key_id": "660e8400-e29b-41d4-a716-446655440000",
    "key_prefix": "whatsapp_live_Kj8",
    "project_name": "Cliente ABC",
    "rate_limit_per_minute": 100,
    "created_at": "2025-01-15T11:00:00Z"
  },
  "warning": "Save this API key securely. It cannot be retrieved again."
}
```

#### Listar API Keys

```http
GET /api/v1/admin/api-keys?is_active=true&limit=50
```

#### Obter Estatísticas

```http
GET /api/v1/admin/stats
```

**Resposta**:
```json
{
  "status": "success",
  "data": {
    "api_keys": {
      "total": 5,
      "active": 4,
      "inactive": 1
    },
    "sessions": {
      "total": 8,
      "connected": 6,
      "disconnected": 2
    },
    "session_manager": {
      "active_sessions": 6,
      "max_concurrent": 50
    }
  }
}
```

## Webhooks

### Mensagens Recebidas

Quando uma mensagem é recebida, a API envia POST para o `webhook_url` configurado:

**Headers**:
- `X-Webhook-Signature`: Assinatura HMAC-SHA256 do payload
- `Content-Type`: application/json

**Payload**:
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "texto": "Oi",
  "numero_remetente": "5511999998888",
  "timestamp": "2025-01-15T10:30:00Z",
  "message_id": "3EB0..."
}
```

### Validar Assinatura

```javascript
const crypto = require('crypto');

function validateWebhook(req, webhookSignatureKey) {
  const signature = req.headers['x-webhook-signature'];
  const payload = JSON.stringify(req.body);

  const expectedSignature = crypto
    .createHmac('sha256', webhookSignatureKey)
    .update(payload)
    .digest('hex');

  return signature === expectedSignature;
}
```

## Códigos de Status HTTP

- `200 OK`: Requisição bem-sucedida
- `201 Created`: Recurso criado
- `400 Bad Request`: Parâmetros inválidos
- `401 Unauthorized`: API key inválida ou ausente
- `403 Forbidden`: Sem permissão para acessar recurso
- `404 Not Found`: Recurso não encontrado
- `429 Too Many Requests`: Rate limit excedido
- `500 Internal Server Error`: Erro no servidor
- `503 Service Unavailable`: Sessão não conectada

## Rate Limiting

A API implementa rate limiting por API key:

- **Padrão**: 60 requisições/minuto
- **Configurável**: Pode ser ajustado por API key
- **Headers de resposta**:
  - `RateLimit-Limit`: Limite total
  - `RateLimit-Remaining`: Requisições restantes
  - `RateLimit-Reset`: Timestamp do reset

## Exemplos de Uso

### cURL

```bash
# Criar sessão
curl -X POST https://api.example.com/api/v1/sessions \
  -H "X-API-Key: sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "session_name": "teste",
    "webhook_url": "https://webhook.site/xxx",
    "webhook_signature_key": "secret"
  }'

# Enviar mensagem
curl -X POST https://api.example.com/api/v1/sessions/SESSION_ID/send-message \
  -H "X-API-Key: sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "numero": "5511999998888",
    "mensagem": "Teste"
  }'
```

### JavaScript (axios)

```javascript
const axios = require('axios');

const API_URL = 'https://api.example.com';
const API_KEY = 'whatsapp_live_xxx';

// Criar sessão
const session = await axios.post(`${API_URL}/api/v1/sessions`, {
  session_name: 'teste',
  webhook_url: 'https://webhook.site/xxx',
  webhook_signature_key: 'secret'
}, {
  headers: { 'X-API-Key': API_KEY }
});

const sessionId = session.data.data.session_id;

// Enviar mensagem
await axios.post(
  `${API_URL}/api/v1/sessions/${sessionId}/send-message`,
  {
    numero: '5511999998888',
    mensagem: 'Olá!'
  },
  {
    headers: { 'X-API-Key': API_KEY }
  }
);
```

## Suporte

Para dúvidas ou problemas:
- **Email**: support@example.com
- **Issues**: https://github.com/seu-repo/issues

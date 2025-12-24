# Guia de Migração - WhatsApp Bot API Multi-Sessão

## 📢 Assunto: Migração para WhatsApp Bot API Multi-Sessão - Ação Necessária

Olá Desenvolvedores,

Estamos transformando o bot de WhatsApp em uma **API multi-sessão reutilizável**. Isso permitirá que cada projeto tenha sua própria conta de WhatsApp conectada com total isolamento e segurança.

---

## 🔑 O Que Mudou?

### **ANTES (versão atual)**
- ❌ Um único bot compartilhado entre todos os projetos
- ❌ Autenticação com `API_SECRET_KEY` fixa
- ❌ Endpoints globais: `/enviar-mensagem`, `/enviar-imagem`
- ❌ Webhook global recebe todas as mensagens

### **DEPOIS (nova versão)**
- ✅ Múltiplas sessões WhatsApp isoladas (uma por projeto)
- ✅ Cada projeto recebe um **API Key único** com rate limiting personalizado
- ✅ Cada projeto cria e gerencia suas próprias **sessões**
- ✅ Webhook configurável por sessão
- ✅ Novos endpoints RESTful: `/api/v1/sessions/:session_id/send-message`
- ✅ Logs e auditoria por sessão

---

## 📅 Timeline de Migração

| Fase | Data | Status |
|------|------|--------|
| **Fase 1: Teste** | Hoje até [DATA + 7 dias] | Ambos sistemas funcionando |
| **Fase 2: Migração** | [DATA + 7 dias] até [DATA + 30 dias] | Obrigatória |
| **Fase 3: Descontinuação** | Após [DATA + 30 dias] | Endpoints antigos desativados |

---

## ✅ Passo a Passo de Migração

### **Passo 1: Receber seu API Key**

Você receberá um API key exclusivo no formato:

```
whatsapp_live_Kj8mN3pQ9rT2vW5xY7zA1bC4dE6fG8hI
```

⚠️ **CRÍTICO**:
- Guarde em local seguro (variável de ambiente)
- Esta chave NÃO será mostrada novamente
- Trate com o mesmo nível de segurança de uma senha

---

### **Passo 2: Criar sua Sessão WhatsApp**

Use a API para criar uma sessão dedicada ao seu projeto:

```bash
curl -X POST https://bot-api.seudominio.com/api/v1/sessions \
  -H "X-API-Key: SEU_API_KEY_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "session_name": "meu-projeto-production",
    "webhook_url": "https://meu-backend.com/webhook/whatsapp",
    "webhook_signature_key": "minha_chave_secreta_hmac_forte"
  }'
```

**Resposta de Sucesso**:
```json
{
  "status": "success",
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "session_name": "meu-projeto-production",
    "status": "disconnected",
    "created_at": "2025-01-15T10:00:00Z"
  }
}
```

**⚠️ IMPORTANTE**: Salve o `session_id` retornado! Você precisará dele em todas as requisições.

---

### **Passo 3: Conectar WhatsApp (Escanear QR Code)**

#### 3.1. Iniciar conexão

```bash
curl -X POST https://bot-api.seudominio.com/api/v1/sessions/550e8400-e29b-41d4-a716-446655440000/connect \
  -H "X-API-Key: SEU_API_KEY_AQUI"
```

#### 3.2. Obter QR Code (polling)

Faça requisições a cada 2-3 segundos até receber o QR code:

```bash
curl https://bot-api.seudominio.com/api/v1/sessions/550e8400-e29b-41d4-a716-446655440000/qr \
  -H "X-API-Key: SEU_API_KEY_AQUI"
```

**Resposta com QR Code**:
```json
{
  "status": "success",
  "data": {
    "qr_code": "data:image/png;base64,iVBORw0KGgoAAAANS...",
    "expires_at": "2025-01-15T10:05:00Z"
  }
}
```

#### 3.3. Exibir QR Code

Mostre o QR code na sua interface (pode usar o `qr_code` base64 em um `<img>` HTML).

#### 3.4. Aguardar Conexão

Após escanear o QR code no WhatsApp:
- A sessão mudará para status `connected`
- Você pode verificar o status com `GET /api/v1/sessions/:session_id`

---

### **Passo 4: Atualizar Código para Enviar Mensagens**

#### **ANTES (código antigo)**:

```javascript
const axios = require('axios');

const response = await axios.post(
  'https://bot-api.seudominio.com/enviar-mensagem',
  {
    numero: '5511999998888',
    mensagem: 'Olá, tudo bem?'
  },
  {
    headers: {
      'X-API-Key': process.env.API_SECRET_KEY // Chave compartilhada
    }
  }
);
```

#### **DEPOIS (código novo)**:

```javascript
const axios = require('axios');

const SESSION_ID = process.env.WHATSAPP_SESSION_ID; // Armazenar session_id
const API_KEY = process.env.WHATSAPP_API_KEY; // Novo API key exclusivo

const response = await axios.post(
  `https://bot-api.seudominio.com/api/v1/sessions/${SESSION_ID}/send-message`,
  {
    numero: '5511999998888',
    mensagem: 'Olá, tudo bem?'
  },
  {
    headers: {
      'X-API-Key': API_KEY
    }
  }
);

// Resposta continua igual
console.log(response.data);
// {
//   "status": "sucesso",
//   "mensagem": "Mensagem enviada com sucesso."
// }
```

---

### **Passo 5: Atualizar Recebimento de Webhooks**

#### **Mudanças no Payload**

**ANTES**:
```json
{
  "texto": "Oi, como vai?",
  "numero_remetente": "5511999998888"
}
```

**DEPOIS**:
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "texto": "Oi, como vai?",
  "numero_remetente": "5511999998888",
  "timestamp": "2025-01-15T10:30:00Z",
  "message_id": "3EB0..."
}
```

#### **Validação de Assinatura HMAC (Recomendado)**

A API assina todos os webhooks com HMAC-SHA256. Valide para garantir autenticidade:

```javascript
const crypto = require('crypto');

function validateWebhook(req, webhookSignatureKey) {
  const signature = req.headers['x-webhook-signature'];
  const payloadString = JSON.stringify(req.body);

  const expectedSignature = crypto
    .createHmac('sha256', webhookSignatureKey)
    .update(payloadString)
    .digest('hex');

  return signature === expectedSignature;
}

// No seu endpoint de webhook
app.post('/webhook/whatsapp', (req, res) => {
  if (!validateWebhook(req, process.env.WEBHOOK_SIGNATURE_KEY)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { session_id, texto, numero_remetente } = req.body;

  // Processar mensagem...

  res.json({ status: 'ok' });
});
```

---

## 🆕 Novos Recursos Disponíveis

### 1. **Múltiplas Sessões**
Crie sessões separadas para dev, staging e production:

```bash
# Sessão de desenvolvimento
POST /api/v1/sessions
{
  "session_name": "meu-projeto-dev",
  ...
}

# Sessão de produção
POST /api/v1/sessions
{
  "session_name": "meu-projeto-production",
  ...
}
```

### 2. **Rate Limiting Personalizado**
Se precisar de mais requisições/minuto, solicite ajuste da sua API key.

### 3. **Logs de Sessão**
Acesse histórico completo de eventos:

```bash
GET /api/v1/sessions/:session_id/logs?limit=100
```

### 4. **Envio em Massa (Broadcast)**
Envie para múltiplos números de uma vez:

```bash
POST /api/v1/sessions/:session_id/send-bulk
{
  "numeros": ["5511999998888", "5511988887777"],
  "mensagem": "Promoção exclusiva!"
}
```

### 5. **Status em Tempo Real**
Monitore o status da sua sessão:

```bash
GET /api/v1/sessions/:session_id
```

---

## 📚 Referência Rápida de Endpoints

| Ação | Método | Endpoint | Descrição |
|------|--------|----------|-----------|
| **Criar sessão** | POST | `/api/v1/sessions` | Cria nova sessão WhatsApp |
| **Listar sessões** | GET | `/api/v1/sessions` | Lista todas as suas sessões |
| **Obter status** | GET | `/api/v1/sessions/:id` | Status detalhado da sessão |
| **Iniciar conexão** | POST | `/api/v1/sessions/:id/connect` | Gera QR code para scan |
| **Obter QR code** | GET | `/api/v1/sessions/:id/qr` | Retorna QR code atual |
| **Enviar mensagem** | POST | `/api/v1/sessions/:id/send-message` | Envia texto |
| **Enviar imagem** | POST | `/api/v1/sessions/:id/send-image` | Envia imagem com caption |
| **Envio em massa** | POST | `/api/v1/sessions/:id/send-bulk` | Broadcast |
| **Desconectar** | POST | `/api/v1/sessions/:id/disconnect` | Desconecta sessão |
| **Deletar** | DELETE | `/api/v1/sessions/:id` | Remove sessão |
| **Logs** | GET | `/api/v1/sessions/:id/logs` | Histórico de eventos |

---

## 🛠️ Variáveis de Ambiente Necessárias

Adicione ao seu `.env`:

```bash
# Nova API Key exclusiva
WHATSAPP_API_KEY=whatsapp_live_xxx

# Session ID criado no passo 2
WHATSAPP_SESSION_ID=550e8400-e29b-41d4-a716-446655440000

# Chave HMAC para validar webhooks
WEBHOOK_SIGNATURE_KEY=sua_chave_secreta_hmac_forte
```

**⚠️ Remover**:
```bash
# Antigas - não mais necessárias
API_SECRET_KEY=xxx  # ❌ Remover
ALLOWED_RECIPIENTS=xxx  # ❌ Remover (agora validado por sessão)
```

---

## ⚠️ Breaking Changes

### 1. **Header de Autenticação**
- Continua sendo `X-API-Key`
- Mas agora usa uma chave exclusiva (não mais compartilhada)

### 2. **URLs dos Endpoints**
| Antigo | Novo |
|--------|------|
| `POST /enviar-mensagem` | `POST /api/v1/sessions/:id/send-message` |
| `POST /enviar-imagem` | `POST /api/v1/sessions/:id/send-image` |
| `GET /status` | `GET /api/v1/sessions/:id` |

### 3. **Payload do Webhook**
- Adiciona `session_id`
- Adiciona `timestamp`
- Adiciona `message_id`

### 4. **Configuração de Webhook**
- Antes: Global (configurado no servidor)
- Agora: Por sessão (configurado na criação)

---

## 🎯 Checklist de Migração

- [ ] Recebi meu API Key e salvei em `.env`
- [ ] Criei minha sessão via POST `/api/v1/sessions`
- [ ] Salvei o `session_id` retornado
- [ ] Conectei WhatsApp escaneando QR code
- [ ] Verifiquei que sessão está `connected`
- [ ] Atualizei código para usar novo endpoint `/api/v1/sessions/:id/send-message`
- [ ] Atualizei validação de webhook (HMAC)
- [ ] Testei envio de mensagens
- [ ] Testei recebimento de webhooks
- [ ] Removi referências antigas (`API_SECRET_KEY`)
- [ ] Atualizei documentação interna do meu projeto

---

## 📞 Suporte & Dúvidas

### Documentação Completa
- **API Reference**: [docs/API.md](./API.md)
- **Exemplos de código**: Veja seção "Exemplos" na documentação

### Canais de Suporte
- **Email**: support@seudominio.com
- **Issues**: https://github.com/seu-repo/issues
- **Chat**: Slack #whatsapp-api

### FAQ

**P: Preciso migrar imediatamente?**
R: Não, você tem até [DATA + 30 dias]. Mas recomendamos migrar o quanto antes.

**P: Posso ter múltiplas sessões?**
R: Sim! Você pode criar até 10 sessões por API key (padrão). Solicite aumento se precisar.

**P: O que acontece se eu não migrar?**
R: Após [DATA + 30 dias], os endpoints antigos serão desativados e seu bot parará de funcionar.

**P: Meus dados/conversas serão perdidos?**
R: Não. A migração preserva todos os dados de autenticação. Sua sessão WhatsApp continuará conectada.

**P: Como testo sem afetar produção?**
R: Crie uma sessão separada com nome diferente (ex: "meu-projeto-dev") e teste com ela.

---

## 🚀 Benefícios da Nova Arquitetura

1. **Isolamento Total**: Suas mensagens não se misturam com outros projetos
2. **Segurança Aprimorada**: API keys exclusivas com rate limiting personalizado
3. **Escalabilidade**: Suporta até 50 sessões simultâneas no servidor
4. **Auditoria Completa**: Logs detalhados de todos os eventos
5. **Webhooks Dedicados**: Configure URLs diferentes para cada sessão
6. **Múltiplos Ambientes**: Dev, staging e production separados
7. **Monitoramento**: Status em tempo real da sua sessão

---

## 📝 Próximos Passos

1. ✅ Leia este guia completamente
2. ✅ Receba seu API Key
3. ✅ Siga o checklist de migração
4. ✅ Teste em ambiente de desenvolvimento
5. ✅ Migre produção
6. ✅ Marque como concluído no tracking board

---

**Equipe de Infraestrutura**

*Última atualização: Janeiro 2025*

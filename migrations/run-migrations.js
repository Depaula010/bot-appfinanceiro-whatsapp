// ========================================
// Script de Migração para API Multi-Sessão
// ========================================
// Este script executa as migrações SQL e migra a sessão existente

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Importar bcrypt apenas se disponível (opcional para primeira migração)
let bcrypt;
try {
    bcrypt = require('bcrypt');
} catch (e) {
    console.warn('⚠️  bcrypt não instalado. Execute: npm install bcrypt');
    process.exit(1);
}

// Configuração do pool PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

/**
 * Gera uma API key no formato whatsapp_live_XXXX
 */
function generateApiKey(env = 'live') {
    const randomBytes = crypto.randomBytes(32).toString('base64url');
    return `whatsapp_${env}_${randomBytes}`;
}

/**
 * Executa um arquivo SQL
 */
async function executeSqlFile(client, filename) {
    const filepath = path.join(__dirname, filename);
    console.log(`📄 Executando ${filename}...`);

    const sql = fs.readFileSync(filepath, 'utf8');
    await client.query(sql);

    console.log(`✅ ${filename} executado com sucesso`);
}

/**
 * Executa todas as migrações
 */
async function runMigrations() {
    const client = await pool.connect();

    try {
        console.log('🚀 Iniciando migrações do banco de dados...\n');

        await client.query('BEGIN');

        // 1. Criar tabela de API keys
        await executeSqlFile(client, '001_create_api_keys_table.sql');

        // 2. Criar tabela de sessões
        await executeSqlFile(client, '002_create_sessions_table.sql');

        // 3. Criar tabela de logs
        await executeSqlFile(client, '003_create_session_logs_table.sql');

        console.log('\n📦 Criando API key default para sistema legado...');

        // 4. Criar API key default
        const apiKey = generateApiKey('live');
        const apiKeyHash = await bcrypt.hash(apiKey, 10);
        const keyPrefix = apiKey.substring(0, 16);

        const keyResult = await client.query(
            `INSERT INTO api_keys (key_hash, key_prefix, project_name, description, rate_limit_per_minute)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [apiKeyHash, keyPrefix, 'Sistema Legado', 'Migrado automaticamente da versão single-session', 120]
        );

        const apiKeyId = keyResult.rows[0].id;
        console.log(`✅ API key criada (ID: ${apiKeyId})`);

        // 5. Criar sessão default
        console.log('\n📱 Criando sessão WhatsApp default...');

        const pythonApiUrl = process.env.PYTHON_API_URL || 'http://localhost:8000';
        const webhookKey = process.env.WEBHOOK_SIGNATURE_KEY || process.env.API_SECRET_KEY || 'default_key';

        const sessionResult = await client.query(
            `INSERT INTO sessions (
                session_name,
                api_key_id,
                webhook_url,
                webhook_signature_key,
                status,
                metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id`,
            [
                'legacy-session',
                apiKeyId,
                `${pythonApiUrl}/webhook-whatsapp`,
                webhookKey,
                'disconnected', // Será conectada quando o bot iniciar
                JSON.stringify({ migrated: true, original_system: true })
            ]
        );

        const sessionId = sessionResult.rows[0].id;
        console.log(`✅ Sessão criada (ID: ${sessionId})`);

        // 6. Migrar baileys_auth existente
        console.log('\n🔐 Migrando dados de autenticação Baileys...');

        const baileysAuthResult = await client.query(
            `UPDATE baileys_auth
             SET session_uuid = $1
             WHERE session_id = 'baileys_session' AND session_uuid IS NULL`,
            [sessionId]
        );

        if (baileysAuthResult.rowCount > 0) {
            console.log(`✅ ${baileysAuthResult.rowCount} registros de autenticação migrados`);
        } else {
            console.log('ℹ️  Nenhum registro de autenticação encontrado (normal se é primeira instalação)');
        }

        // 7. Commit da transação
        await client.query('COMMIT');

        // Salvar API key em arquivo seguro em vez de exibir em logs
        const keyFilePath = path.join(__dirname, '..', '.api-key-generated.txt');
        const keyFileContent = [
            'WHATSAPP API KEY - GERADA PELA MIGRACAO',
            '========================================',
            'IMPORTANTE: Salve esta chave em local seguro e DELETE este arquivo!',
            '',
            `WHATSAPP_API_KEY=${apiKey}`,
            `WHATSAPP_SESSION_ID=${sessionId}`,
            '',
            `Key Prefix: ${keyPrefix}`,
            `Project Name: Sistema Legado`,
            `Gerada em: ${new Date().toISOString()}`,
        ].join('\n');

        fs.writeFileSync(keyFilePath, keyFileContent, { mode: 0o600 });

        console.log('\n' + '='.repeat(80));
        console.log('✅ MIGRAÇÕES CONCLUÍDAS COM SUCESSO!');
        console.log('='.repeat(80));
        console.log(`\n🔑 API Key salva em: ${keyFilePath}`);
        console.log(`   Key Prefix: ${keyPrefix}...`);
        console.log(`\n🆔 Session ID: ${sessionId}`);
        console.log('📂 Project Name: Sistema Legado\n');
        console.log('📝 Próximos passos:');
        console.log('   1. Copie a API key do arquivo .api-key-generated.txt');
        console.log('   2. Adicione ao seu .env');
        console.log('   3. DELETE o arquivo .api-key-generated.txt');
        console.log('   4. Execute: npm install (para instalar novas dependências)');
        console.log('   5. Reinicie a aplicação\n');
        console.log('='.repeat(80) + '\n');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ ERRO durante migração:', error);
        console.error('\nStack trace:', error.stack);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Executar migrações
if (require.main === module) {
    runMigrations()
        .then(() => {
            console.log('🎉 Processo de migração finalizado!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Falha crítica na migração');
            process.exit(1);
        });
}

module.exports = { runMigrations, generateApiKey };

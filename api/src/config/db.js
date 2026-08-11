const { Pool } = require('pg');
require('dotenv').config();
// Monta a string de conexão no padrão universal (URI)
const connectionString = `postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
const pool = new Pool({
  connectionString: connectionString,
  keepAlive: true,            // evita que o firewall/servidor derrube conexões ociosas
  idleTimeoutMillis: 30000,   // fecha conexões ociosas do pool de forma limpa
  connectionTimeoutMillis: 15000,
  // O ETL mantém 1 cliente dedicado por ciclo (minutos) e cada consulta de recorte
  // pega o seu; com o default (10) dois usuários simultâneos já esgotavam o pool.
  max: 20,
});
// Erros de clientes OCIOSOS do pool (ex.: conexão derrubada entre ciclos do ETL)
// são tratados aqui — sem este handler o processo cai com 'unhandled error'.
pool.on('error', (err) => {
  console.error('[db] erro em cliente ocioso do pool (ignorado, o pool recria):', err.message);
});

async function getClient() {
  const client = await pool.connect();
  // Cliente dedicado (temp table) vive ~minutos durante o ETL. Se a conexão cair
  // no meio, o evento 'error' precisa de listener senão derruba o processo todo.
  client.on('error', (err) => {
    console.error('[db] erro em cliente dedicado (ETL):', err.message);
  });
  return client;
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient,
};
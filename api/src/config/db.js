const { Pool } = require('pg');
require('dotenv').config();
// Monta a string de conexão no padrão universal (URI)
const connectionString = `postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

// ── Defesa contra "processo fantasma" no banco ────────────────────────────────
// Se o node morre de forma abrupta (kill -9 / TerminateProcess / queda de rede), o
// socket TCP não fecha limpo. O Postgres NÃO percebe que o cliente sumiu e mantém o
// backend rodando a query pesada do ETL (active, IO: DataFileRead) sem ninguém pra
// receber o resultado — só morre quando o tcp_keepalive do servidor detecta o peer
// morto, o que leva HORAS. Cada restart empilha mais um fantasma e o banco afunda.
//
// Nenhum handler de sinal salva desse caso (TerminateProcess não dispara handler),
// então a proteção tem que estar no PRÓPRIO BANCO, por sessão:
//   statement_timeout                    -> mata query órfã que ficou 'active'
//   idle_in_transaction_session_timeout  -> mata transação órfã que ficou 'idle in transaction'
// Juntos cobrem os dois estados possíveis de um fantasma.
// O teto é rede de segurança contra query órfã, NÃO limite de tempo de trabalho:
// tem que ser maior que a etapa legítima mais lenta. Medido nesta base, o ciclo
// completo leva ~1480s (24,7 min) e o _buildAbcd90 (janela de 90 dias) passa de
// 10 min sozinho — com o teto em 10 min ele morria com
// "canceling statement due to statement timeout" e a aba Clientes A-I ficava sem
// dado. 30 min cobre a etapa mais lenta com folga e ainda mata órfã em tempo útil.
// Se alguma etapa passar disso, sobe via DB_STATEMENT_TIMEOUT_MS em vez de remover.
const STMT_TIMEOUT_MS = Math.max(60000, parseInt(process.env.DB_STATEMENT_TIMEOUT_MS, 10) || 1800000);     // 30 min
const IDLE_TX_TIMEOUT_MS = Math.max(30000, parseInt(process.env.DB_IDLE_TX_TIMEOUT_MS, 10) || 120000);      // 2 min

const pool = new Pool({
  connectionString: connectionString,
  keepAlive: true,            // evita que o firewall/servidor derrube conexões ociosas
  idleTimeoutMillis: 30000,   // fecha conexões ociosas do pool de forma limpa
  connectionTimeoutMillis: 15000,
  // O ETL mantém 1 cliente dedicado por ciclo (minutos) e cada consulta de recorte
  // pega o seu; com o default (10) dois usuários simultâneos já esgotavam o pool.
  max: 20,
  // Identifica as sessões no pg_stat_activity — dá pra separar o que é este portal
  // do que é cronjob/outras APIs quando for investigar carga no banco.
  application_name: 'portal-comercial-api',
  // Aplicado a TODA conexão nova do pool, inclusive as do ETL.
  options: `-c statement_timeout=${STMT_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${IDLE_TX_TIMEOUT_MS}`,
});
// Erros de clientes OCIOSOS do pool (ex.: conexão derrubada entre ciclos do ETL)
// são tratados aqui — sem este handler o processo cai com 'unhandled error'.
pool.on('error', (err) => {
  console.error('[db] erro em cliente ocioso do pool (ignorado, o pool recria):', err.message);
});

// Clientes dedicados atualmente em uso (ETL). Guardados para que o shutdown possa
// DESTRUIR o socket — ao fechar o socket de verdade, o Postgres recebe o FIN e
// encerra o backend na hora, em vez de deixar a query rodando como fantasma.
const clientesAtivos = new Set();

async function getClient() {
  const client = await pool.connect();
  // Cliente dedicado (temp table) vive ~minutos durante o ETL. Se a conexão cair
  // no meio, o evento 'error' precisa de listener senão derruba o processo todo.
  client.on('error', (err) => {
    console.error('[db] erro em cliente dedicado (ETL):', err.message);
  });

  clientesAtivos.add(client);
  // Embrulha release() para sair do registro exatamente uma vez, seja no caminho
  // normal (finally do ETL) ou no shutdown.
  const releaseOriginal = client.release.bind(client);
  let liberado = false;
  client.release = (destruir) => {
    if (liberado) return;
    liberado = true;
    clientesAtivos.delete(client);
    return releaseOriginal(destruir);
  };
  return client;
}

// Encerramento limpo. Idempotente.
//
// Ponto importante: só FECHAR o socket não cancela a query que já está rodando. O
// backend do Postgres está fazendo IO em disco, não lendo o socket — ele só descobre
// que o cliente sumiu quando tenta ESCREVER o resultado, ou seja, depois de varrer a
// base inteira. É exatamente por isso que aparecia um "processo fantasma" moendo o
// banco depois da API já ter morrido.
// Cancelamento de verdade exige pedir ao próprio Postgres: pg_cancel_backend(pid)
// numa conexão NOVA, usando o PID do backend (client.processID).
let encerrando = null;
async function closePool() {
  if (encerrando) return encerrando;
  encerrando = (async () => {
    const emVoo = Array.from(clientesAtivos);
    if (emVoo.length) {
      const pids = emVoo.map(c => c.processID).filter(Boolean);
      console.log(`[db] cancelando ${emVoo.length} query(ies) do ETL em voo no banco (pids: ${pids.join(', ') || 'n/d'})...`);

      // Conexão separada só para cancelar — a do ETL está ocupada e não responde.
      if (pids.length) {
        const canceler = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 8000, application_name: 'portal-comercial-api-cancel' });
        try {
          const r = await canceler.query('SELECT pid, pg_cancel_backend(pid) AS cancelado FROM unnest($1::int[]) AS t(pid)', [pids]);
          console.log('[db] cancelamento:', r.rows.map(x => `${x.pid}=${x.cancelado}`).join(' '));
        } catch (err) {
          console.error('[db] falha ao cancelar backends (o statement_timeout ainda cobre):', err.message);
        } finally {
          await canceler.end().catch(() => {});
        }
      }

      // Agora sim, destrói os sockets do ETL.
      for (const client of emVoo) {
        try { client.release(true); } catch (e) { /* já morto, ignora */ }
      }
    }
    try {
      await pool.end();
      console.log('[db] pool encerrado, nenhuma conexão pendente.');
    } catch (err) {
      console.error('[db] erro ao encerrar pool:', err.message);
    }
  })();
  return encerrando;
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient,
  closePool,
  conexoesEmVoo: () => clientesAtivos.size,
};

require('dotenv').config();
const app = require('./app');
const db = require('./config/db');
const DashboardCacheManager = require('./jobs/DashboardCacheManager');

const PORT = process.env.PORT || 3000;

// Rede de segurança: um blip de conexão com o banco não deve derrubar a API
// (ela continua servindo o último cache pronto). Erros são logados; o próximo
// ciclo do ETL se reconecta pelo pool.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException (mantendo processo vivo):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandledRejection:', err && err.message ? err.message : err);
});

const server = app.listen(PORT, () => {
  console.log("Servidor da API inicializado com sucesso na porta " + PORT);
  DashboardCacheManager.start(); // dispara ETL imediato + agenda ciclos
});

// ── Shutdown gracioso ─────────────────────────────────────────────────────────
// Sem isto, encerrar a API deixava o backend do Postgres rodando a query pesada do
// ETL como "processo fantasma" (active / IO: DataFileRead), porque o socket não
// fechava limpo e o servidor só percebia horas depois via tcp_keepalive.
// Aqui: para o agendador, fecha o HTTP e DESTRÓI as conexões do ETL em voo — o
// Postgres recebe o FIN e encerra o backend na hora.
//
// ATENÇÃO: no Windows, `kill -9` / Stop-Process -Force / TerminateProcess NÃO
// disparam handler nenhum. Para esse caso a proteção é o statement_timeout e o
// idle_in_transaction_session_timeout aplicados por sessão em config/db.js.
let encerrando = false;
async function shutdown(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`\n[server] ${sinal} recebido — encerrando (${db.conexoesEmVoo()} conexão(ões) do ETL em voo)...`);

  // Trava de segurança: se algo pendurar, sai à força em 10s em vez de ficar
  // preso com conexões abertas no banco.
  const forcar = setTimeout(() => {
    console.error('[server] shutdown demorou demais, saindo à força.');
    process.exit(1);
  }, 10000);
  forcar.unref();

  try {
    DashboardCacheManager.stop();              // não agenda novo ciclo
    await new Promise(r => server.close(r));   // para de aceitar requisições
    await db.closePool();                      // destrói ETL em voo + fecha pool
    console.log('[server] encerrado sem deixar conexão órfã no banco.');
    clearTimeout(forcar);
    process.exit(0);
  } catch (err) {
    console.error('[server] erro no shutdown:', err.message);
    process.exit(1);
  }
}

// SIGINT = Ctrl+C. SIGTERM = docker stop / kill. SIGBREAK = Ctrl+Break (Windows).
for (const sinal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sinal, () => shutdown(sinal));
}

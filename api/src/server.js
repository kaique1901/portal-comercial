require('dotenv').config();
const app = require('./app');
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

app.listen(PORT, () => {
  console.log("Servidor da API inicializado com sucesso na porta " + PORT);
  DashboardCacheManager.start(); // dispara ETL imediato + agenda ciclos
});

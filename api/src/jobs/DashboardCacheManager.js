const DashboardETLService = require('../services/DashboardETLService');

// ETL pesado (reproduz todo o schema do painel a partir do banco). Roda 1 ciclo
// no boot e recicla a cada intervalo. Sem snapshot/Excel: TUDO vem do DB.
const INTERVALO_MS = 10 * 60 * 1000; // 10 min (o ciclo completo leva ~6-7 min)

class DashboardCacheManager {
  constructor() {
    this._cache = null;
    this._atualizadoEm = null;
    this._rodando = false;
    this._timer = null;
  }

  async _executarCiclo() {
    if (this._rodando) {
      console.warn('[DashboardCache] ciclo anterior ainda rodando, pulando este tick.');
      return;
    }
    this._rodando = true;
    const inicio = Date.now();
    try {
      const dados = await DashboardETLService.run();
      this._cache = dados;
      this._atualizadoEm = new Date();
      console.log(`[DashboardCache] atualizado (100% DB) em ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error('[DashboardCache] ETL falhou, mantendo cache anterior:', err.message);
    } finally {
      this._rodando = false;
    }
  }

  start() {
    this._executarCiclo();
    this._timer = setInterval(() => this._executarCiclo(), INTERVALO_MS);
  }

  stop() {
    clearInterval(this._timer);
  }

  getCache() {
    return this._cache;
  }

  getMeta() {
    return { atualizadoEm: this._atualizadoEm, pronto: this._cache !== null };
  }
}

module.exports = new DashboardCacheManager();

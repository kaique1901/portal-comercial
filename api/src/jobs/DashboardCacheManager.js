const DashboardETLService = require('../services/DashboardETLService');

// ETL pesado (reproduz todo o schema do painel a partir do banco). Roda 1 ciclo
// no boot e recicla a cada intervalo. Sem snapshot/Excel: TUDO vem do DB.
//
// IMPORTANTE — por que não usar setInterval:
// O ciclo completo (4 semestres × CREATE TEMP TABLE + ~60 agregações, mais estoque
// /abcd90/hierarquia) leva vários minutos. Com setInterval curto, o timer vence
// enquanto o ciclo ainda roda; quando o ciclo termina, o próximo já está vencido e
// dispara na hora — ETL pesado back-to-back, o banco nunca descansa.
// Aqui o próximo ciclo é agendado a partir do FIM do anterior (setTimeout
// encadeado), garantindo um intervalo REAL de descanso entre varreduras.
//
// Intervalo configurável por env ETL_INTERVALO_MIN (minutos). Default 360 (6h):
// o painel é mensal, não precisa de varredura de minuto em minuto.
const INTERVALO_MIN = Math.max(1, parseInt(process.env.ETL_INTERVALO_MIN, 10) || 360);
const INTERVALO_MS = INTERVALO_MIN * 60 * 1000;

// Em FALHA o intervalo longo não serve: o painel ficaria horas em 503 esperando o
// próximo ciclo. Retry com backoff exponencial curto (2, 4, 8, 16 min... até o teto
// do intervalo normal). Backoff, e não retry imediato, justamente para não insistir
// em cima de um banco que acabou de recusar/matar a query.
const RETRY_BASE_MS = 2 * 60 * 1000;
const RETRY_MAX_MS = INTERVALO_MS;

class DashboardCacheManager {
  constructor() {
    this._cache = null;
    this._atualizadoEm = null;
    this._rodando = false;
    this._timer = null;
    this._parado = false;
    this._falhas = 0;
  }

  // Devolve true se o ciclo terminou com sucesso.
  async _executarCiclo() {
    if (this._rodando) {
      console.warn('[DashboardCache] ciclo anterior ainda rodando, pulando este tick.');
      return false;
    }
    this._rodando = true;
    const inicio = Date.now();
    try {
      // Publica cada etapa assim que fica pronta, para o painel sair do 503 já no
      // primeiro período (o semestre atual) em vez de esperar o ciclo inteiro.
      // Só publica quando existe pelo menos um período — nunca objeto vazio, que
      // daria 200 sem dado nenhum.
      const dados = await DashboardETLService.run(parcial => {
        const temPeriodo = Object.keys(parcial).some(k => !k.startsWith('_'));
        if (!temPeriodo) return;
        this._cache = { ...parcial };
        this._atualizadoEm = new Date();
      });
      this._cache = dados;
      this._atualizadoEm = new Date();
      this._falhas = 0;
      console.log(`[DashboardCache] atualizado (100% DB) em ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
      return true;
    } catch (err) {
      this._falhas++;
      console.error(`[DashboardCache] ETL falhou (${this._falhas}ª vez), mantendo cache anterior:`, err.message);
      return false;
    } finally {
      this._rodando = false;
    }
  }

  // Agenda o próximo ciclo contando a partir de AGORA (fim do anterior), não de um
  // relógio fixo — isso é o que garante o descanso do banco entre varreduras.
  // Em falha usa backoff curto para o painel não ficar horas sem dado.
  _agendarProximo(ok) {
    if (this._parado) return;
    const espera = ok
      ? INTERVALO_MS
      : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, this._falhas - 1)));
    console.log(`[DashboardCache] próximo ciclo em ${(espera / 60000).toFixed(0)} min${ok ? '' : ' (retry após falha)'}.`);
    this._timer = setTimeout(async () => {
      const sucesso = await this._executarCiclo();
      this._agendarProximo(sucesso);
    }, espera);
  }

  async start() {
    this._parado = false;
    console.log(`[DashboardCache] intervalo entre varreduras: ${INTERVALO_MIN} min (a partir do fim de cada ciclo).`);
    const ok = await this._executarCiclo(); // 1º ciclo no boot
    this._agendarProximo(ok);               // demais ciclos, sempre com folga após o anterior
  }

  stop() {
    this._parado = true;
    if (this._timer) clearTimeout(this._timer);
  }

  getCache() {
    return this._cache;
  }

  getMeta() {
    return { atualizadoEm: this._atualizadoEm, pronto: this._cache !== null };
  }
}

module.exports = new DashboardCacheManager();

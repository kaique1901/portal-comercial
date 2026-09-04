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

// Etapas não-período do ciclo, na ordem em que o ETL as produz. Serve para o
// /etl-status dizer ao front O QUE ainda falta — sem isso o front não tem como
// distinguir "não existe dado" de "o ETL ainda não chegou nessa etapa", e as abas
// que dependem delas ficam vazias sem explicação.
const ETAPAS_EXTRA = ['_hierarquia', '_estoque', '_abcd90', '_dowCascata', '_inadimplencia', '_clientesSemCompra60'];

class DashboardCacheManager {
  constructor() {
    this._cache = null;
    this._atualizadoEm = null;
    this._rodando = false;
    this._timer = null;
    this._parado = false;
    this._falhas = 0;
    this._cicloInicio = null;
  }

  // Radiografia do que já está no cache. Barato (só olha chaves), então pode ser
  // servido em rota própria e consultado de 30 em 30s pelo front, em vez de
  // rebaixar 5 MB de /full só para saber se uma etapa chegou.
  _montarEtlInfo(parcial, completo) {
    const total = (DashboardETLService.PERIODOS || []).map(p => p.key);
    const prontos = total.filter(k => parcial[k]);
    const etapas = {};
    ETAPAS_EXTRA.forEach(k => { etapas[k.replace(/^_/, '')] = !!parcial[k]; });
    const faltando = [
      ...total.filter(k => !parcial[k]),
      ...ETAPAS_EXTRA.filter(k => !parcial[k]),
    ];
    return {
      completo: !!completo && !faltando.length,
      // No publish final o `finally` que zera _rodando ainda não correu, então
      // derivamos de `completo` em vez de ler a flag.
      rodando: completo ? false : this._rodando,
      cicloInicio: this._cicloInicio ? this._cicloInicio.toISOString() : null,
      atualizadoEm: this._atualizadoEm ? this._atualizadoEm.toISOString() : null,
      periodos: { prontos, total: total.length, faltando: total.filter(k => !parcial[k]) },
      etapas,
      faltando,
      falhasConsecutivas: this._falhas,
      // Duração da última etapa concluída de cada tipo (segundos). Serve para
      // responder "por que demora" sem abrir o log do servidor.
      tempos: parcial._tempos || null,
    };
  }

  // Só o metadado, sem payload. Usado por GET /etl-status.
  getStatus() {
    const base = this._cache || {};
    if (!this._cache) {
      return {
        completo: false, rodando: this._rodando, pronto: false,
        cicloInicio: this._cicloInicio ? this._cicloInicio.toISOString() : null,
        atualizadoEm: null,
        periodos: { prontos: [], total: (DashboardETLService.PERIODOS || []).length, faltando: (DashboardETLService.PERIODOS || []).map(p => p.key) },
        etapas: ETAPAS_EXTRA.reduce((o, k) => (o[k.replace(/^_/, '')] = false, o), {}),
        faltando: [...(DashboardETLService.PERIODOS || []).map(p => p.key), ...ETAPAS_EXTRA],
        falhasConsecutivas: this._falhas,
      };
    }
    return { pronto: true, ...(base._etl || this._montarEtlInfo(base, false)) };
  }

  // Devolve true se o ciclo terminou com sucesso.
  async _executarCiclo() {
    if (this._rodando) {
      console.warn('[DashboardCache] ciclo anterior ainda rodando, pulando este tick.');
      return false;
    }
    this._rodando = true;
    const inicio = Date.now();
    this._cicloInicio = new Date();
    try {
      // Publica cada etapa assim que fica pronta, para o painel sair do 503 já no
      // primeiro período (o semestre atual) em vez de esperar o ciclo inteiro.
      // Só publica quando existe pelo menos um período — nunca objeto vazio, que
      // daria 200 sem dado nenhum.
      // O cache do ciclo anterior vai junto: períodos FECHADOS são reaproveitados
      // dele em vez de remontados (ver _periodoFechado no ETL). Guardamos a
      // referência antes, porque o callback parcial sobrescreve this._cache.
      const cachePrevio = this._cache;
      const dados = await DashboardETLService.run(parcial => {
        const temPeriodo = Object.keys(parcial).some(k => !k.startsWith('_'));
        if (!temPeriodo) return;
        this._atualizadoEm = new Date();
        this._cache = { ...parcial, _etl: this._montarEtlInfo(parcial, false) };
      }, cachePrevio);
      this._atualizadoEm = new Date();
      this._falhas = 0;
      this._cache = { ...dados, _etl: this._montarEtlInfo(dados, true) };
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

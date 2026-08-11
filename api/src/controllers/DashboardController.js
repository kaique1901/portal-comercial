const DashboardService = require('../services/DashboardService');
const DashboardClienteService = require('../services/DashboardClienteService');
const DashboardRecorteService = require('../services/DashboardRecorteService');
const DashboardCacheManager = require('../jobs/DashboardCacheManager');

// filtros aceitos em /recorte → chave da query string
const RECORTE_KEYS = ['cli', 'ger', 'sup', 'vend', 'cat', 'grp', 'canal', 'inad', 'status', 'mes'];

class DashboardController {

  // Recorte exato para qualquer combinação de filtros (o cubo não cruza todas).
  // GET /api/v1/dashboard/recorte?periodo=2026_1&ger=G02 - GUILHERME&canal=BAR
  // Listas separadas por "|" (nomes podem conter vírgula).
  async getRecorte(req, res) {
    try {
      const periodo = req.query.periodo || '2026_1';
      const filtros = {};
      let n = 0;
      for (const k of RECORTE_KEYS) {
        const raw = req.query[k];
        if (raw == null || raw === '') continue;
        const vals = String(raw).split('|').map(s => s.trim()).filter(Boolean);
        if (!vals.length) continue;
        if (vals.length > 500) return res.status(400).json({ error: `máximo de 500 valores em ${k}` });
        filtros[k] = vals; n += vals.length;
      }
      if (!n) return res.status(400).json({ error: 'informe ao menos um filtro' });
      res.json(await DashboardRecorteService.getScope(periodo, filtros));
    } catch (error) {
      console.error('[recorte]', error.message);
      res.status(500).json({ error: 'Erro ao consultar recorte', details: error.message });
    }
  }

  // Recorte por cliente consultado sob demanda no banco (o cubo só tem Top-50).
  // GET /api/v1/dashboard/clientes?periodo=2026_1&cods=11274,659800157
  async getClientes(req, res) {
    try {
      const periodo = req.query.periodo || '2026_1';
      const cods = String(req.query.cods || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (!cods.length) return res.status(400).json({ error: 'informe cods=1,2,3' });
      if (cods.length > 500) return res.status(400).json({ error: 'máximo de 500 clientes por consulta' });
      const dados = await DashboardClienteService.getScope(periodo, cods);
      res.json(dados);
    } catch (error) {
      console.error('[clientes]', error.message);
      res.status(500).json({ error: 'Erro ao consultar clientes', details: error.message });
    }
  }

  // Serve o JSON pré-processado pelo cron (instantâneo, sem query no request).
  async getFull(req, res) {
    const cache = DashboardCacheManager.getCache();
    if (!cache) {
      return res.status(503).json({ error: 'Cache ainda não pronto, tente novamente em instantes.' });
    }
    res.json(cache);
  }

  // Função auxiliar para interpretar o 'periodo' (ex: "2026_1")
  _parsePeriodo(periodo) {
    // Valores padrão de segurança (se não informar período)
    let dataInicial = '2026-01-01';
    let dataFinal = '2026-06-30';
    
    if (periodo === '2026_1') {
      dataInicial = '2026-01-01';
      dataFinal = '2026-06-30';
    } else if (periodo === '2026_2') {
      dataInicial = '2026-07-01';
      dataFinal = '2026-12-31';
    }
    return { dataInicial, dataFinal };
  }

  async getResumo(req, res) {
    try {
      const { dataInicial, dataFinal } = this._parsePeriodo(req.query.periodo);
      const resumo = await DashboardService.getResumo(dataInicial, dataFinal);
      res.json(resumo);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao buscar resumo' });
    }
  }

  async getVendasPorDia(req, res) {
    try {
      const { dataInicial, dataFinal } = this._parsePeriodo(req.query.periodo);
      const vendas = await DashboardService.getVendasPorDia(dataInicial, dataFinal);
      res.json(vendas);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao buscar vendas por dia' });
    }
  }

  async getCategorias(req, res) {
    try {
      const { dataInicial, dataFinal } = this._parsePeriodo(req.query.periodo);
      const categorias = await DashboardService.getCategorias(dataInicial, dataFinal);
      res.json(categorias);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao buscar categorias' });
    }
  }

  async getHierarquia(req, res) {
    try {
      const { dataInicial, dataFinal } = this._parsePeriodo(req.query.periodo);
      const hierarquia = await DashboardService.getHierarquia(dataInicial, dataFinal);
      res.json(hierarquia);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao buscar hierarquia' });
    }
  }
}

module.exports = new DashboardController();

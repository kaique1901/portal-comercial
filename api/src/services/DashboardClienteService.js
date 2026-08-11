const db = require('../config/db');
const ETL = require('./DashboardETLService');

// O cubo do dashboard guarda só o Top-50 de clientes por período. Para recortar
// por QUALQUER cliente da carteira (código vindo da API de Roteiro), consultamos
// o banco sob demanda reaproveitando o mesmo BASE_CTE do ETL — assim os números
// batem exatamente com o cubo. O filtro por CodCliente entra no WHERE interno
// (empurra o predicado para o índice: ~0,2s por consulta).
const ANCHOR = 'and pedidos.datafechamento::date <= $2';
const BASE_CTE_CLI = (() => {
  const cte = ETL.BASE_CTE;
  if (!cte || !cte.includes(ANCHOR)) {
    throw new Error('DashboardClienteService: âncora do filtro não encontrada no BASE_CTE');
  }
  return cte.replace(ANCHOR, `${ANCHOR}\n    and Pedidos.CodCliente = ANY($3::int[])`);
})();

const num = v => parseFloat(v) || 0;
const round2 = v => Math.round(v * 100) / 100;
const margem = (r, c) => (r > 0 ? round2((1 - c / r) * 100) : 0);

// Cache curto: o mesmo recorte é pedido várias vezes (KPIs, gráficos, tabelas).
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.em > TTL_MS) { cache.delete(key); return null; }
  return hit.dados;
}
function cacheSet(key, dados) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { em: Date.now(), dados });
}

class DashboardClienteService {
  _periodo(key) {
    const p = (ETL.PERIODOS || []).find(x => x.key === key);
    if (!p) throw new Error(`período inválido: ${key}`);
    return p;
  }

  // Recorte agregado de um conjunto de clientes dentro de um período.
  async getScope(periodoKey, cods) {
    const periodo = this._periodo(periodoKey);
    const codsInt = [...new Set(cods.map(c => parseInt(c, 10)).filter(Number.isFinite))];
    if (!codsInt.length) throw new Error('nenhum código de cliente válido');

    const key = `${periodoKey}|${codsInt.slice().sort((a, b) => a - b).join(',')}`;
    const hit = cacheGet(key);
    if (hit) return hit;

    const params = [periodo.ini, periodo.fim, codsInt];
    const q = sql => db.query(sql, params).then(r => r.rows);

    const [tot, porMes, porCat, porGrp, porCli, topProd] = await Promise.all([
      q(`WITH base AS (${BASE_CTE_CLI})
         SELECT SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(Peso) p,
                COUNT(DISTINCT NroPed) pedidos, COUNT(*) linhas, COUNT(DISTINCT CodCli) n_cli
         FROM base`),
      q(`WITH base AS (${BASE_CTE_CLI})
         SELECT Mes mes, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(Peso) p,
                COUNT(DISTINCT NroPed) pedidos
         FROM base GROUP BY Mes ORDER BY Mes`),
      q(`WITH base AS (${BASE_CTE_CLI})
         SELECT categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(Peso) p
         FROM base WHERE categoria IS NOT NULL GROUP BY categoria`),
      q(`WITH base AS (${BASE_CTE_CLI})
         SELECT Grupo grupo, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(Peso) p
         FROM base WHERE Grupo IS NOT NULL GROUP BY Grupo, categoria`),
      q(`WITH base AS (${BASE_CTE_CLI})
         SELECT CodCli codigo, Cliente nome, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
                COUNT(DISTINCT Mes) meses_ativos, COUNT(DISTINCT codcateg) categorias
         FROM base GROUP BY CodCli, Cliente ORDER BY r DESC`),
      q(`WITH base AS (${BASE_CTE_CLI})
         SELECT Codigo codigo, Descricao nome, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq
         FROM base WHERE Descricao IS NOT NULL GROUP BY Codigo, Descricao, categoria
         ORDER BY r DESC LIMIT 50`)
    ]);

    const t = tot[0] || {};
    const r = num(t.r), c = num(t.c);

    const dados = {
      periodo: periodoKey,
      cods: codsInt,
      r: round2(r), c: round2(c), q: round2(num(t.qq)), p: round2(num(t.p)),
      m: margem(r, c),
      cash_margem: round2(r - c),
      pedidos: parseInt(t.pedidos, 10) || 0,
      linhas: parseInt(t.linhas, 10) || 0,
      n_clientes_com_venda: parseInt(t.n_cli, 10) || 0,
      por_mes: {},
      por_categoria: {},
      por_grupo: {},
      clientes: porCli.map(row => {
        const rr = num(row.r), cc = num(row.c);
        return {
          codigo: String(row.codigo), nome: row.nome,
          r: round2(rr), c: round2(cc), q: round2(num(row.qq)), m: margem(rr, cc),
          cash_margin: round2(rr - cc),
          meses_ativos: parseInt(row.meses_ativos, 10) || 0,
          categorias: parseInt(row.categorias, 10) || 0
        };
      }),
      top_produtos: topProd.map(row => {
        const rr = num(row.r), cc = num(row.c);
        return {
          codigo: String(row.codigo), nome: row.nome, categoria: row.categoria,
          r: round2(rr), c: round2(cc), q: round2(num(row.qq)), m: margem(rr, cc)
        };
      })
    };

    for (const row of porMes) {
      const rr = num(row.r), cc = num(row.c);
      dados.por_mes[String(row.mes)] = {
        r: round2(rr), c: round2(cc), q: round2(num(row.qq)), p: round2(num(row.p)),
        m: margem(rr, cc), pedidos: parseInt(row.pedidos, 10) || 0
      };
    }
    for (const row of porCat) {
      const rr = num(row.r), cc = num(row.c);
      dados.por_categoria[row.categoria] = { r: round2(rr), c: round2(cc), q: round2(num(row.qq)), p: round2(num(row.p)), m: margem(rr, cc) };
    }
    for (const row of porGrp) {
      const rr = num(row.r), cc = num(row.c);
      dados.por_grupo[row.grupo] = { r: round2(rr), c: round2(cc), q: round2(num(row.qq)), p: round2(num(row.p)), m: margem(rr, cc), categoria: row.categoria };
    }

    cacheSet(key, dados);
    return dados;
  }
}

module.exports = new DashboardClienteService();

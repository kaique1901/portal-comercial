const db = require('../config/db');
const ETL = require('./DashboardETLService');

// Recorte EXATO sob demanda, para qualquer combinação de filtros do painel.
// O cubo pré-agregado só cruza algumas dimensões (ex.: hier_por_categoria); filtros
// como Canal de Vendas, Inadimplente e Status do Cliente não existem cruzados com
// hierarquia, e cliente fora do Top-50 nem aparece. Aqui reaproveitamos o BASE_CTE
// do ETL com um WHERE dinâmico, então os números batem com o cubo por construção.
//
// Colunas do BASE_CTE usadas nos filtros: gerente, supervisor, Vendedor, categoria,
// Grupo, CodCli, canal_vendas, inadimplente, status_cliente.
const isoDay = ETL.isoDay;
const num = v => parseFloat(v) || 0;
const round2 = v => Math.round(v * 100) / 100;
const margem = (r, c) => (r > 0 ? round2((1 - c / r) * 100) : 0);

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 300;
const cache = new Map();
const cacheGet = key => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.em > TTL_MS) { cache.delete(key); return null; }
  return hit.dados;
};
const cacheSet = (key, dados) => {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { em: Date.now(), dados });
};

// Onde cada filtro é aplicado importa MUITO para o tempo de resposta:
//  • "interno": vai no WHERE do subselect de Pedidos/ItensPedido, antes dos joins de
//    produto e da subquery de inadimplência (que roda por linha) — reduz o volume na
//    origem. Filtrar gerente só no fim levava ~110s; interno cai para segundos.
//  • "externo": depende de colunas que só existem depois dos joins (categoria/grupo)
//    ou de expressão calculada (inadimplente) — aplicado no wrapper.
const CAMPOS_INTERNOS = [
  { key: 'cli',    expr: 'Pedidos.CodCliente',   tipo: 'int[]'  },
  { key: 'ger',    expr: 'gerente.nomegerente',  tipo: 'text[]' },
  { key: 'sup',    expr: 'supervisor.nomesupervisor', tipo: 'text[]' },
  { key: 'vend',   expr: 'EQVEND.NOMVEN',        tipo: 'text[]' },
  { key: 'canal',  expr: 'a.desati',             tipo: 'text[]' },
  { key: 'status', expr: `(case when eqclid.sitcli = true then 'Inativo' else 'Ativo' end)`, tipo: 'text[]' },
  // Mês: o painel trabalha por mês, então o recorte já vem filtrado — evita depender
  // de grão diário no cubo e deixa todas as abas coerentes com o mês selecionado.
  { key: 'mes',    expr: 'extract(month from Pedidos.DataFechamento)', tipo: 'int[]' },
];
const CAMPOS_EXTERNOS = [
  { key: 'cat',    expr: 'b.categoria',     tipo: 'text[]' },
  { key: 'grp',    expr: 'b.grupo',         tipo: 'text[]' },
  { key: 'inad',   expr: 'b.inadimplente',  tipo: 'text[]' },
];

// Inadimplência fica no wrapper (b.inadimplente), que o BASE_CTE já resolve por JOIN
// dedupado. Tentar empurrar como EXISTS correlacionado no WHERE interno gerou plano
// pior (>300s) — medido; não repetir.
const CAMPOS = [...CAMPOS_INTERNOS, ...CAMPOS_EXTERNOS];
const ANCHOR = 'and pedidos.datafechamento::date <= $2';

class DashboardRecorteService {
  _periodo(key) {
    const p = (ETL.PERIODOS || []).find(x => x.key === key);
    if (!p) throw new Error(`período inválido: ${key}`);
    return p;
  }

  // filtros: { cli:[cods], ger:[], sup:[], vend:[], cat:[], grp:[], canal:[], inad:[], status:[] }
  async getScope(periodoKey, filtros) {
    const periodo = this._periodo(periodoKey);

    // Normaliza: só entram filtros com valor. Cliente é inteiro; o resto, texto.
    const ativos = [];
    for (const campo of CAMPOS) {
      const vals = filtros[campo.key];
      if (!Array.isArray(vals) || !vals.length) continue;
      if (campo.key === 'cli' || campo.key === 'mes') {
        const ints = [...new Set(vals.map(v => parseInt(v, 10)).filter(Number.isFinite))];
        if (ints.length) ativos.push({ ...campo, vals: ints });
      } else {
        const txt = [...new Set(vals.map(v => String(v)).filter(Boolean))];
        if (txt.length) ativos.push({ ...campo, vals: txt });
      }
    }
    if (!ativos.length) throw new Error('nenhum filtro informado');

    const key = periodoKey + '|' + ativos
      .map(a => `${a.key}=${a.vals.slice().sort().join('~')}`)
      .sort().join('&');
    const hit = cacheGet(key);
    if (hit) return hit;

    // $1/$2 são as datas do BASE_CTE; os filtros seguem a partir de $3.
    const params = [periodo.ini, periodo.fim];
    const cond = a => { params.push(a.vals); return `${a.expr} = ANY($${params.length}::${a.tipo})`; };
    const internos = ativos.filter(a => CAMPOS_INTERNOS.some(c => c.key === a.key)).map(cond);
    const externos = ativos.filter(a => CAMPOS_EXTERNOS.some(c => c.key === a.key)).map(cond);

    if (!ETL.BASE_CTE.includes(ANCHOR)) throw new Error('âncora do filtro não encontrada no BASE_CTE');
    const cte = internos.length
      ? ETL.BASE_CTE.replace(ANCHOR, `${ANCHOR}\n    and ${internos.join('\n    and ')}`)
      : ETL.BASE_CTE;
    const base = externos.length
      ? `SELECT * FROM (${cte}) b WHERE ${externos.join(' AND ')}`
      : `SELECT * FROM (${cte}) b`;
    // Materializa o recorte UMA vez numa TEMP TABLE e agrega em cima dela (mesma
    // estratégia do ETL). Antes eram 7 consultas em paralelo repetindo o BASE_CTE
    // inteiro: 7 varreduras do período e 7 conexões — o pool esgotava
    // ("timeout exceeded when trying to connect") com dois usuários simultâneos.
    const client = await db.getClient();
    let tot, porMes, porCat, porGrp, porCli, topProd, porVend;
    let porDia, porDiaCat, porGer, porSup, fullVend, porMesCli, pag, janProd, janRange, abcdCli, abcdBuilt, abcdCliCat, abcdCliVend, qual, casc, fumo;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE tmp_recorte ON COMMIT DROP AS ${base}`, params);
      const q = async sql => (await client.query(sql)).rows;

      tot = await q(`SELECT SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(Peso) p,
                            COUNT(DISTINCT NroPed) pedidos, COUNT(*) linhas,
                            COUNT(DISTINCT CodCli) n_cli, COUNT(DISTINCT CodVen) n_vend
                     FROM tmp_recorte`);
      porMes = await q(`SELECT Mes mes, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
                               COUNT(DISTINCT NroPed) pedidos
                        FROM tmp_recorte GROUP BY Mes ORDER BY Mes`);
      porCat = await q(`SELECT categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(Peso) p
                        FROM tmp_recorte WHERE categoria IS NOT NULL GROUP BY categoria`);
      porGrp = await q(`SELECT Grupo grupo, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq
                        FROM tmp_recorte WHERE Grupo IS NOT NULL GROUP BY Grupo, categoria`);
      porCli = await q(`SELECT CodCli codigo, Cliente nome, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
                               COUNT(DISTINCT Mes) meses_ativos, COUNT(DISTINCT codcateg) categorias
                        FROM tmp_recorte GROUP BY CodCli, Cliente ORDER BY r DESC LIMIT 50`);
      topProd = await q(`SELECT Codigo codigo, Descricao nome, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq
                         FROM tmp_recorte WHERE Descricao IS NOT NULL GROUP BY Codigo, Descricao, categoria
                         ORDER BY r DESC LIMIT 50`);
      porVend = await q(`SELECT Vendedor nome, supervisor, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq
                         FROM tmp_recorte WHERE Vendedor IS NOT NULL GROUP BY Vendedor, supervisor
                         ORDER BY r DESC LIMIT 50`);
      // Demais visões do painel — todas devem enxergar SÓ o recorte (mesmas formas
      // que o cubo produz, para o front poder trocar uma pela outra).
      porDia = await q(`SELECT DataPed::date dia, SUM(Total) r, SUM(customedio) c
                        FROM tmp_recorte GROUP BY DataPed::date ORDER BY 1`);
      porDiaCat = await q(`SELECT DataPed::date dia, categoria, SUM(Total) r, SUM(customedio) c
                           FROM tmp_recorte WHERE categoria IS NOT NULL GROUP BY DataPed::date, categoria ORDER BY 1`);
      porGer = await q(`SELECT gerente, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
                               SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest
                        FROM tmp_recorte WHERE gerente IS NOT NULL GROUP BY gerente`);
      porSup = await q(`SELECT supervisor, gerente, SUM(Total) r, SUM(customedio) c,
                               SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest
                        FROM tmp_recorte WHERE supervisor IS NOT NULL GROUP BY supervisor, gerente`);
      fullVend = await q(`SELECT Vendedor nome, supervisor, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
                                 SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest
                          FROM tmp_recorte WHERE Vendedor IS NOT NULL GROUP BY Vendedor, supervisor`);
      porMesCli = await q(`SELECT Mes mes, COUNT(DISTINCT CodCli) n FROM tmp_recorte GROUP BY Mes`);
      // Realizado da meta FUMO KG = realkg (produtos siglaagrufat='FF'), mesma regra
      // do ETL e da query oficial de Meta x Realizado.
      fumo = {
        mes: await q(`SELECT Mes mes, SUM(realkg) kg FROM tmp_recorte GROUP BY Mes`),
        ger: await q(`SELECT gerente k, SUM(realkg) kg FROM tmp_recorte WHERE gerente IS NOT NULL GROUP BY gerente`),
        sup: await q(`SELECT supervisor k, SUM(realkg) kg FROM tmp_recorte WHERE supervisor IS NOT NULL GROUP BY supervisor`),
        vend: await q(`SELECT Vendedor k, SUM(realkg) kg FROM tmp_recorte WHERE Vendedor IS NOT NULL GROUP BY Vendedor`)
      };
      pag = await q(`SELECT categoria, tipo, tipocob, SUM(Total) v
                     FROM tmp_recorte WHERE categoria IS NOT NULL GROUP BY categoria, tipo, tipocob`);
      janRange = (await q(`SELECT MIN(DataPed) ini, MAX(DataPed) fim FROM tmp_recorte`))[0];
      janProd = await q(`SELECT Codigo codigo, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq
                         FROM tmp_recorte
                         WHERE DataPed >= (SELECT MAX(DataPed) FROM tmp_recorte) - INTERVAL '89 days'
                         GROUP BY Codigo`);
      abcdCli = await q(`SELECT CodCli codigo, Cliente nome, SUM(Total) r, SUM(customedio) c
                         FROM tmp_recorte WHERE Cliente IS NOT NULL GROUP BY CodCli, Cliente`);
      // Mesmo raciocínio do ETL: só pré-calcula a cascata de categoria/vendedor para
      // os ~100 maiores de cada quadrante (abcd.top100Codes) — cliente fora disso
      // recai no aviso "sem detalhamento" no front em vez de reconsultar o banco.
      abcdBuilt = ETL.buildAbcd(abcdCli);
      abcdCliCat = abcdBuilt.top100Codes.length ? (await client.query(`
        SELECT CodCli codigo, categoria, SUM(Total) r, SUM(customedio) c
        FROM tmp_recorte WHERE CodCli = ANY($1::int[]) AND categoria IS NOT NULL
        GROUP BY CodCli, categoria`, [abcdBuilt.top100Codes])).rows : [];
      abcdCliVend = abcdBuilt.top100Codes.length ? (await client.query(`
        SELECT CodCli codigo, CodVen vcodigo, Vendedor vnome, supervisor, SUM(Total) r
        FROM tmp_recorte WHERE CodCli = ANY($1::int[]) AND Vendedor IS NOT NULL
        GROUP BY CodCli, CodVen, Vendedor, supervisor ORDER BY CodCli, SUM(Total) DESC`, [abcdBuilt.top100Codes])).rows : [];
      qual = (await q(`SELECT
          COUNT(*) FILTER (WHERE CodCli IS NULL) sem_cli, COUNT(*) FILTER (WHERE Codigo IS NULL) sem_prod,
          COUNT(*) FILTER (WHERE CodVen IS NULL) sem_vend, COUNT(*) FILTER (WHERE Total<=0) rec_zero,
          COUNT(*) FILTER (WHERE Qtde<=0) qtd_zero, COUNT(*) FILTER (WHERE customedio>Total) custo_maior
        FROM tmp_recorte`))[0];
      // Cascata Categoria → Grupo → Fornecedor → Produto: mesmas colunas das queries
      // do ETL, para poder usar o buildCascata dele sem adaptação.
      casc = {
        cat: await q(`SELECT categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) q, SUM(Peso) p,
                             COUNT(DISTINCT CodCli) n_cli, COUNT(DISTINCT Grupo) n_grp
                      FROM tmp_recorte WHERE categoria IS NOT NULL GROUP BY categoria`),
        grp: await q(`SELECT categoria, Grupo grupo, SUM(Total) r, SUM(customedio) c, SUM(Qtde) q, SUM(Peso) p,
                             COUNT(DISTINCT CodCli) n_cli, COUNT(DISTINCT Fornecedor) n_for
                      FROM tmp_recorte WHERE categoria IS NOT NULL AND Grupo IS NOT NULL GROUP BY categoria, Grupo`),
        forn: await q(`SELECT categoria, Grupo grupo, Fornecedor fornecedor, SUM(Total) r, SUM(customedio) c,
                              SUM(Qtde) q, SUM(Peso) p, COUNT(DISTINCT CodCli) n_cli, COUNT(DISTINCT Codigo) n_prod
                       FROM tmp_recorte WHERE categoria IS NOT NULL AND Grupo IS NOT NULL AND Fornecedor IS NOT NULL
                       GROUP BY categoria, Grupo, Fornecedor`),
        prod: await q(`SELECT categoria, Grupo grupo, Fornecedor fornecedor, Descricao produto,
                              SUM(Total) r, SUM(customedio) c, SUM(Qtde) q, SUM(Peso) p, COUNT(DISTINCT CodCli) n_cli
                       FROM tmp_recorte WHERE categoria IS NOT NULL AND Grupo IS NOT NULL
                         AND Fornecedor IS NOT NULL AND Descricao IS NOT NULL
                       GROUP BY categoria, Grupo, Fornecedor, Descricao`)
      };
      await client.query('COMMIT');   // COMMIT derruba a temp table (ON COMMIT DROP)
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }

    const t = tot[0] || {};
    const r = num(t.r), c = num(t.c);
    const linha = row => { const rr = num(row.r), cc = num(row.c); return { r: round2(rr), c: round2(cc), q: round2(num(row.qq)), m: margem(rr, cc), cash_margin: round2(rr - cc) }; };

    const dados = {
      periodo: periodoKey,
      filtros: ativos.reduce((o, a) => { o[a.key] = a.vals; return o; }, {}),
      r: round2(r), c: round2(c), q: round2(num(t.qq)), p: round2(num(t.p)),
      m: margem(r, c), cash_margem: round2(r - c),
      pedidos: parseInt(t.pedidos, 10) || 0,
      linhas: parseInt(t.linhas, 10) || 0,
      n_clientes: parseInt(t.n_cli, 10) || 0,
      n_vendedores: parseInt(t.n_vend, 10) || 0,
      ticket_pedido: (parseInt(t.pedidos, 10) || 0) > 0 ? round2(r / parseInt(t.pedidos, 10)) : 0,
      por_mes: {}, por_categoria: {}, por_grupo: {},
      clientes: porCli.map(row => Object.assign({ codigo: String(row.codigo), nome: row.nome }, linha(row), {
        meses_ativos: parseInt(row.meses_ativos, 10) || 0,
        categorias: parseInt(row.categorias, 10) || 0
      })),
      top_produtos: topProd.map(row => Object.assign({ codigo: String(row.codigo), nome: row.nome, categoria: row.categoria }, linha(row))),
      vendedores: porVend.map(row => Object.assign({ nome: row.nome, supervisor: row.supervisor }, linha(row)))
    };

    for (const row of porMes) dados.por_mes[String(row.mes)] = Object.assign(linha(row), { pedidos: parseInt(row.pedidos, 10) || 0 });
    for (const row of porCat) dados.por_categoria[row.categoria] = Object.assign(linha(row), { p: round2(num(row.p)) });
    for (const row of porGrp) dados.por_grupo[row.grupo] = Object.assign(linha(row), { categoria: row.categoria });

    // ── mesmas formas do cubo, para o front substituir campo a campo ──────────
    dados.por_dia = {};
    for (const row of porDia) {
      const k = isoDay(row.dia);
      const acc = dados.por_dia[k] || (dados.por_dia[k] = [0, 0]);
      acc[0] += num(row.r); acc[1] += num(row.c);
    }
    for (const k in dados.por_dia) { dados.por_dia[k][0] = round2(dados.por_dia[k][0]); dados.por_dia[k][1] = round2(dados.por_dia[k][1]); }

    dados.por_dia_categoria = {};
    for (const row of porDiaCat) {
      const k = isoDay(row.dia);
      const dia = dados.por_dia_categoria[k] || (dados.por_dia_categoria[k] = {});
      const acc = dia[row.categoria] || (dia[row.categoria] = [0, 0]);
      acc[0] += num(row.r); acc[1] += num(row.c);
    }
    for (const k in dados.por_dia_categoria) for (const cat in dados.por_dia_categoria[k]) {
      const a = dados.por_dia_categoria[k][cat]; a[0] = round2(a[0]); a[1] = round2(a[1]);
    }

    dados.por_gerente = {};
    // rp/rkg/rest: realizado de Papel/Kg/Estratégico — a aba Meta x Realizado depende
    // deles; sem isso o recorte apagaria esses valores da tela.
    for (const row of porGer) { const rr = num(row.r), cc = num(row.c); dados.por_gerente[row.gerente] = { r: round2(rr), c: round2(cc), q: round2(num(row.qq)), m: margem(rr, cc), rp: round2(num(row.rp)), rkg: round2(num(row.rkg)), rest: round2(num(row.rest)) }; }
    dados.por_supervisor = {};
    for (const row of porSup) { const rr = num(row.r), cc = num(row.c); dados.por_supervisor[row.supervisor] = { r: round2(rr), c: round2(cc), m: margem(rr, cc), rp: round2(num(row.rp)), rkg: round2(num(row.rkg)), rest: round2(num(row.rest)), gerente: row.gerente }; }
    dados.full_vendedores = {};
    for (const row of fullVend) { const rr = num(row.r), cc = num(row.c); dados.full_vendedores[row.nome] = { r: round2(rr), c: round2(cc), q: round2(num(row.qq)), m: margem(rr, cc), rp: round2(num(row.rp)), rkg: round2(num(row.rkg)), rest: round2(num(row.rest)), supervisor: row.supervisor }; }

    dados.por_mes_clientes = {};
    for (const row of porMesCli) dados.por_mes_clientes[String(row.mes)] = parseInt(row.n, 10) || 0;

    const dictKg = rows => { const o = {}; for (const r of rows) if (r.k) o[r.k] = round2(num(r.kg)); return o; };
    dados.por_mes_fumokg = {};
    for (const row of fumo.mes) dados.por_mes_fumokg[String(row.mes)] = round2(num(row.kg));
    dados.realizado_fumokg = { por_gerente: dictKg(fumo.ger), por_supervisor: dictKg(fumo.sup), por_vendedor: dictKg(fumo.vend) };

    dados.pagamento_por_categoria = {};
    for (const row of pag) {
      const cat = dados.pagamento_por_categoria[row.categoria] || (dados.pagamento_por_categoria[row.categoria] = {});
      const tipo = cat[row.tipo] || (cat[row.tipo] = {});
      tipo[row.tipocob] = round2(num(row.v));
    }

    dados.janela90 = {
      inicio: janRange && janRange.ini ? isoDay(janRange.ini) : null,
      fim: janRange && janRange.fim ? isoDay(janRange.fim) : null
    };
    dados.por_produto_janela90 = {};
    for (const row of janProd) dados.por_produto_janela90[String(row.codigo)] = { r: round2(num(row.r)), c: round2(num(row.c)), q: round2(num(row.qq)) };

    dados.qualidade = {
      linhas_sem_cliente: parseInt(qual.sem_cli, 10) || 0,
      linhas_sem_produto: parseInt(qual.sem_prod, 10) || 0,
      linhas_sem_vendedor: parseInt(qual.sem_vend, 10) || 0,
      linhas_receita_zero_ou_negativa: parseInt(qual.rec_zero, 10) || 0,
      linhas_qtde_zero_ou_negativa: parseInt(qual.qtd_zero, 10) || 0,
      linhas_custo_maior_que_receita: parseInt(qual.custo_maior, 10) || 0
    };

    // Builders compartilhados com o ETL → formato idêntico ao do cubo.
    dados.abcd = abcdBuilt;
    dados.abcd_clientes_detalhe = (() => {
      const out = {};
      for (const row of abcdCliCat || []) {
        const k = String(row.codigo);
        const entry = out[k] || (out[k] = { categorias: {}, vendedor: null });
        entry.categorias[row.categoria] = { r: round2(num(row.r)), c: round2(num(row.c)) };
      }
      const seen = new Set();
      for (const row of abcdCliVend || []) {
        const k = String(row.codigo);
        if (seen.has(k)) continue; // ORDER BY CodCli, receita DESC — 1ª linha = vendedor dominante
        seen.add(k);
        const entry = out[k] || (out[k] = { categorias: {}, vendedor: null });
        entry.vendedor = { codigo: String(row.vcodigo), nome: row.vnome, supervisor: row.supervisor };
      }
      return out;
    })();
    dados.cascata = ETL.buildCascata(casc.cat, casc.grp, casc.forn, casc.prod);

    // Listas "cash" (ordenadas por cash margin) nas mesmas formas do cubo.
    const porCash = (arr, extra) => arr.slice()
      .map(row => { const rr = num(row.r), cc = num(row.c); return Object.assign({ codigo: String(row.codigo != null ? row.codigo : row.nome), nome: row.nome, r: round2(rr), c: round2(cc), cash_margin: round2(rr - cc), m: margem(rr, cc) }, extra ? extra(row) : {}); })
      .sort((a, b) => b.cash_margin - a.cash_margin).slice(0, 50);
    dados.top_clientes_cash = porCash(porCli);
    dados.top_produtos_cash = porCash(topProd, row => ({ categoria: row.categoria }));
    dados.top_vendedores_cash = porCash(porVend, row => ({ supervisor: row.supervisor }));

    cacheSet(key, dados);
    return dados;
  }
}

module.exports = new DashboardRecorteService();

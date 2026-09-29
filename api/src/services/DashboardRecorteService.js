const path = require('path');
const fsp = require('fs').promises;
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

// O recorte frio custa de ~15s a >3 min (medido: 198s com o ETL rodando no banco),
// e é ele que segura a tela "Aplicando o seu escopo de acesso…" no boot. Com TTL de
// 5 min quase todo login caía no frio. Agora a entrada vale o mesmo que o cubo
// (ciclo do ETL, 6h por padrão) e o escopo de abertura de cada gerente/supervisor
// é pré-calculado ao fim de cada ciclo (ver prewarm) e gravado em disco, para
// sobreviver a restart da API.
const TTL_MS = Math.max(1, parseInt(process.env.RECORTE_TTL_MIN, 10) || parseInt(process.env.ETL_INTERVALO_MIN, 10) || 360) * 60 * 1000;
// Escopos pré-aquecidos valem até o PRÓXIMO prewarm substituí-los. O próximo ciclo
// é agendado 6h após o FIM do anterior (+ duração do ciclo e do prewarm), então com
// TTL de 6h eles expirariam antes de serem renovados e o login voltaria ao frio.
// 2× o TTL cobre a folga; se o ETL falhar por muito tempo, eles acabam expirando.
const TTL_PREWARM_MS = TTL_MS * 2;
const MAX_ENTRIES = 400;
const PREWARM_KEYS = new Set();
const cache = new Map();
const cacheGet = key => {
  const hit = cache.get(key);
  if (!hit) return null;
  const ttl = PREWARM_KEYS.has(key) ? TTL_PREWARM_MS : TTL_MS;
  if (Date.now() - hit.em > ttl) { cache.delete(key); return null; }
  return hit.dados;
};
const cacheSet = (key, dados, em = Date.now()) => {
  cache.delete(key);   // reinsere no fim: a expulsão por tamanho tira a mais antiga
  if (cache.size >= MAX_ENTRIES) {
    // Nunca expulsa um escopo de abertura por causa de consultas avulsas.
    for (const k of cache.keys()) { if (!PREWARM_KEYS.has(k)) { cache.delete(k); break; } }
  }
  cache.set(key, { em, dados });
};
// Consultas em voo por chave: boot + re-render + vigia do ETL pedindo o MESMO
// recorte ao mesmo tempo viravam N varreduras idênticas no banco.
const emVoo = new Map();

const ARQ_PREWARM = path.join(__dirname, '..', '..', '.cache-etl', 'recorte-prewarm.json');

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
  // ANOMES ("2026-07") permite selecionar meses de ANOS DIFERENTES na mesma
  // consulta — Jul/2026 + Jul/2025, por exemplo. `mes` sozinho é ambíguo entre
  // anos, e o cubo é materializado por semestre, então comparar anos por ali
  // exigiria várias consultas. Aqui o intervalo de datas do BASE_CTE passa a ser
  // derivado do menor e do maior mês escolhidos (ver _limitesDeAnomes), e este
  // filtro recorta exatamente os meses pedidos dentro dele.
  { key: 'anomes', expr: `to_char(Pedidos.DataFechamento,'YYYY-MM')`, tipo: 'text[]' },
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

  // Menor e maior data cobertas por uma lista de "YYYY-MM". Vira o intervalo
  // $1/$2 do BASE_CTE, no lugar das datas do semestre: com Jul/2025 + Jul/2026 a
  // varredura precisa abranger os dois anos. O filtro `anomes` recorta os meses
  // exatos dentro desse intervalo, então meses no meio (Ago/2025 … Jun/2026) são
  // lidos pela varredura mas não entram no resultado.
  _limitesDeAnomes(lista) {
    const ordenados = lista.slice().sort();
    const primeiro = ordenados[0], ultimo = ordenados[ordenados.length - 1];
    const [aF, mF] = ultimo.split('-').map(Number);
    const fimMes = new Date(Date.UTC(aF, mF, 0)).toISOString().slice(0, 10); // dia 0 do mês seguinte = último dia
    return { ini: `${primeiro}-01`, fim: fimMes };
  }

  // filtros: { cli:[cods], ger:[], sup:[], vend:[], cat:[], grp:[], canal:[], inad:[], status:[], anomes:['2026-07'] }
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
    if (emVoo.has(key)) return emVoo.get(key);
    const p = this._consultar(periodo, ativos, key).finally(() => emVoo.delete(key));
    emVoo.set(key, p);
    return p;
  }

  async _consultar(periodo, ativos, key) {
    // $1/$2 são as datas do BASE_CTE; os filtros seguem a partir de $3.
    // Com `anomes`, o intervalo vem da própria seleção (pode cruzar anos) em vez
    // das datas do semestre.
    const selAnomes = ativos.find(a => a.key === 'anomes');
    const janela = selAnomes ? this._limitesDeAnomes(selAnomes.vals) : { ini: periodo.ini, fim: periodo.fim };
    const params = [janela.ini, janela.fim];
    const cond = a => { params.push(a.vals); return `${a.expr} = ANY($${params.length}::${a.tipo})`; };
    // `anomes` NÃO entra por `= ANY(to_char(...))`: essa expressão não é indexável,
    // então o banco varreria a janela inteira (Jul/2025 a Set/2026 = 15 meses) só
    // para descartar o meio — medido em 41s. Como faixa de datas por mês, o
    // índice idx_pedidos_data_fechamento_date é usado e só os meses pedidos são
    // lidos.
    const condAnomes = a => '(' + a.vals.slice().sort().map(am => {
      const [ano, mes] = am.split('-').map(Number);
      const ini = `${am}-01`;
      const fim = new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
      params.push(ini, fim);
      return `(pedidos.datafechamento::date >= $${params.length - 1} and pedidos.datafechamento::date <= $${params.length})`;
    }).join(' or ') + ')';
    const internos = ativos.filter(a => CAMPOS_INTERNOS.some(c => c.key === a.key))
      .map(a => a.key === 'anomes' ? condAnomes(a) : cond(a));
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
    let tot, porMes, porAnomes, porCat, porGrp, porCli, topProd, porVend;
    let porDia, porDiaCat, porGer, porSup, fullVend, porMesCli, porMesCatCliCod, pag, janProd, janRange, abcdCli, qual, casc, fumo;
    let cliDetCat, cliDetVend, prodDetVend;
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
      // Quebra por ANO-MÊS. por_mes agrupa só pelo número do mês, então uma
      // seleção como Jul/2026 + Jul/2025 colapsaria os dois anos na chave "7" e o
      // gráfico mensal mostraria uma barra só, com a soma. Aqui cada ano-mês fica
      // separado.
      porAnomes = await q(`SELECT to_char(DataPed,'YYYY-MM') anomes, SUM(Total) r, SUM(customedio) c,
                                  SUM(Qtde) qq, COUNT(DISTINCT NroPed) pedidos
                           FROM tmp_recorte GROUP BY 1 ORDER BY 1`);
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
      // CASCATA ("+") das abas Top 50. Sem isto, com filtro de hierarquia ativo a
      // lista de clientes/produtos vem do recorte mas o detalhe continuava vindo
      // do cubo — que tem OUTROS clientes — e o "+" sumia na maioria das linhas.
      // Restrito aos códigos já rankeados, não à base inteira.
      const codsCli = porCli.map(r => r.codigo).filter(v => v != null);
      cliDetCat = codsCli.length ? await q(`
        SELECT CodCli codigo, categoria, SUM(Total) r, SUM(customedio) c
        FROM tmp_recorte WHERE CodCli = ANY(ARRAY[${codsCli.map(Number).filter(Number.isFinite).join(',') || 'NULL'}]::int[])
          AND categoria IS NOT NULL GROUP BY CodCli, categoria`) : [];
      cliDetVend = codsCli.length ? await q(`
        SELECT CodCli codigo, MIN(CodVen) vcodigo, Vendedor vnome, MIN(supervisor) supervisor, SUM(Total) r
        FROM tmp_recorte WHERE CodCli = ANY(ARRAY[${codsCli.map(Number).filter(Number.isFinite).join(',') || 'NULL'}]::int[])
          AND Vendedor IS NOT NULL GROUP BY CodCli, Vendedor`) : [];
      const codsProd = topProd.map(r => r.codigo).filter(v => v != null);
      // Produto nunca teve cascata em aba nenhuma. Detalhe = quem vendeu.
      prodDetVend = codsProd.length ? await q(`
        SELECT Codigo codigo, Vendedor vnome, MIN(supervisor) supervisor,
               SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq
        FROM tmp_recorte WHERE Codigo = ANY(ARRAY[${codsProd.map(Number).filter(Number.isFinite).join(',') || 'NULL'}]::int[])
          AND Vendedor IS NOT NULL GROUP BY Codigo, Vendedor`) : [];
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
      // POSITIVAÇÃO recortada. Devolve a LISTA de códigos de cliente por mês+categoria,
      // não a contagem: o painel soma vários meses e precisa unir os conjuntos antes de
      // contar (cliente que comprou em jul e ago é UM positivado, não dois). Sem isto o
      // recorte não trazia o insumo, o cubo da empresa ficava valendo no lugar dele e a
      // coluna Positivação caía em "—" para qualquer usuário logado — que sempre tem
      // escopo travado, portanto sempre com recorte ativo.
      porMesCatCliCod = await q(`SELECT Mes mes, categoria, array_agg(DISTINCT CodCli) cods
                                 FROM tmp_recorte WHERE categoria IS NOT NULL AND CodCli IS NOT NULL
                                 GROUP BY Mes, categoria`);
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
      // abcd aqui serve só o q(A-D 2x2)/mediana para Riscos & Oportunidades quando
      // o recorte tem Canal/Inadimplente/Status/Cliente ativos — a aba "Clientes de
      // A a I" tem fonte própria (janela fixa de 90 dias, independente de recorte).
      abcdCli = await q(`SELECT CodCli codigo, Cliente nome, SUM(Total) r, SUM(customedio) c
                         FROM tmp_recorte WHERE Cliente IS NOT NULL GROUP BY CodCli, Cliente`);
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
      periodo: periodo.key,
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
    dados.por_anomes = {};
    for (const row of porAnomes) dados.por_anomes[row.anomes] = Object.assign(linha(row), { pedidos: parseInt(row.pedidos, 10) || 0 });

    // Detalhe da cascata "+" — mesma forma que o cubo usa em
    // top_clientes_cash_detalhe: { codcli: { categorias:{cat:{r,c}}, vendedor:{...} } }
    dados.clientes_detalhe = {};
    for (const row of cliDetCat || []) {
      const k = String(row.codigo);
      const e = dados.clientes_detalhe[k] || (dados.clientes_detalhe[k] = { categorias: {}, vendedor: null });
      e.categorias[row.categoria] = { r: round2(num(row.r)), c: round2(num(row.c)) };
    }
    // Vendedor DOMINANTE do cliente no recorte (maior receita) — mesmo critério do cubo.
    const melhorVend = {};
    for (const row of cliDetVend || []) {
      const k = String(row.codigo), r = num(row.r);
      if (melhorVend[k] !== undefined && r <= melhorVend[k]) continue;
      melhorVend[k] = r;
      const e = dados.clientes_detalhe[k] || (dados.clientes_detalhe[k] = { categorias: {}, vendedor: null });
      e.vendedor = { codigo: String(row.vcodigo), nome: row.vnome, supervisor: row.supervisor };
    }

    // Produto nunca teve cascata. Detalhe = vendedores que venderam o produto,
    // do maior para o menor faturamento.
    dados.produtos_detalhe = {};
    for (const row of prodDetVend || []) {
      const k = String(row.codigo);
      const e = dados.produtos_detalhe[k] || (dados.produtos_detalhe[k] = { vendedores: [] });
      const rr = num(row.r), cc = num(row.c);
      e.vendedores.push({ nome: row.vnome, supervisor: row.supervisor, r: round2(rr), c: round2(cc), q: round2(num(row.qq)), m: margem(rr, cc) });
    }
    for (const k in dados.produtos_detalhe) {
      dados.produtos_detalhe[k].vendedores.sort((a, b) => b.r - a.r);
    }
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

    // Mesma forma do cubo: { mes: { categoria: [codCliente, ...] } }. O front une os
    // conjuntos dos meses selecionados e só então conta (ver somaDistinta em app.js).
    dados.por_mes_categoria_clientes_cod = {};
    dados.por_mes_categoria_clientes = {};
    for (const row of porMesCatCliCod) {
      const mes = String(row.mes);
      const cods = (row.cods || []).map(Number).filter(Number.isFinite);
      (dados.por_mes_categoria_clientes_cod[mes] || (dados.por_mes_categoria_clientes_cod[mes] = {}))[row.categoria] = cods;
      (dados.por_mes_categoria_clientes[mes] || (dados.por_mes_categoria_clientes[mes] = {}))[row.categoria] = cods.length;
    }

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
    dados.abcd = ETL.buildAbcd(abcdCli);
    dados.cascata = ETL.buildCascata(casc.cat, casc.grp, casc.forn, casc.prod);

    // Listas "cash" (ordenadas por cash margin) nas mesmas formas do cubo.
    const porCash = (arr, extra) => arr.slice()
      .map(row => { const rr = num(row.r), cc = num(row.c); return Object.assign({ codigo: String(row.codigo != null ? row.codigo : row.nome), nome: row.nome, r: round2(rr), c: round2(cc), cash_margin: round2(rr - cc), m: margem(rr, cc) }, extra ? extra(row) : {}); })
      .sort((a, b) => b.cash_margin - a.cash_margin).slice(0, 50);
    dados.top_clientes_cash = porCash(porCli);
    dados.top_produtos_cash = porCash(topProd, row => ({ categoria: row.categoria }));
    dados.top_vendedores_cash = porCash(porVend, row => ({ supervisor: row.supervisor }));

    // Top 50 por Margem % (razão), reordenando o MESMO Top 50 por receita já
    // consultado acima (porCli/topProd) em vez de rodar outra query — mesma
    // aproximação já assumida no filtro de hierarquia ("o recorte pode não conter
    // o cliente/produto de maior margem da empresa como um todo"). Importante:
    // por reaproveitar o mesmo pool de códigos, clientes_detalhe/produtos_detalhe
    // (cascata "+") abaixo cobrem esta lista também, sem precisar de query extra.
    const porMargemPct = (arr, extra) => arr.slice()
      .map(row => { const rr = num(row.r), cc = num(row.c); return Object.assign({ codigo: String(row.codigo != null ? row.codigo : row.nome), nome: row.nome, r: round2(rr), c: round2(cc), cash_margin: round2(rr - cc), m: margem(rr, cc) }, extra ? extra(row) : {}); })
      .sort((a, b) => b.m - a.m).slice(0, 50);
    dados.top_clientes_margem = porMargemPct(porCli);
    dados.top_produtos_margem = porMargemPct(topProd, row => ({ categoria: row.categoria }));

    cacheSet(key, dados);
    return dados;
  }

  // ── PRÉ-AQUECIMENTO ───────────────────────────────────────────────────────
  // Todo gerente/supervisor logado abre o painel com o MESMO recorte: ele próprio
  // no mês corrente (+ o mesmo mês do ano anterior, para os deltas). São ~60
  // pessoas, então dá para deixar tudo pronto antes de alguém logar. Chamado ao fim
  // de cada ciclo do ETL — nunca durante, para não competir com ele no banco — e
  // em série, uma consulta por vez.
  //
  // Os parâmetros espelham o boot do front (aplicarPeriodoEMesPadrao/prevScopeKey
  // em public/js/app.js); se aquela escolha mudar, mude aqui também, senão o
  // pré-aquecimento vira consulta que ninguém usa.
  _alvosDeAbertura(cubo) {
    const hoje = new Date();
    const atual = `${hoje.getFullYear()}_${hoje.getMonth() < 6 ? 1 : 2}`;
    const ordem = (ETL.PERIODOS || []).map(p => p.key).sort().reverse();
    const per = cubo[atual] ? atual : ordem.find(k => cubo[k]);
    if (!per) return [];
    const mesesPer = Object.keys((cubo[per] && cubo[per].por_mes) || {}).map(Number);
    if (!mesesPer.length) return [];
    const hojeMes = hoje.getMonth() + 1;
    const mes = mesesPer.includes(hojeMes) ? hojeMes : Math.max(...mesesPer);
    const [ano, sem] = per.split('_').map(Number);
    const mm = String(mes).padStart(2, '0');
    const alvos = [{ periodo: per, anomes: `${ano}-${mm}` }];
    const prev = `${ano - 1}_${sem}`;
    if ((ETL.PERIODOS || []).some(p => p.key === prev)) alvos.push({ periodo: prev, anomes: `${ano - 1}-${mm}` });
    return alvos;
  }

  async prewarm(cubo) {
    const hier = cubo && cubo._hierarquia;
    if (!hier || !Array.isArray(hier.gerentes)) return;
    const ger = new Set(), sup = new Set();
    for (const g of hier.gerentes) {
      if (g.nomegerente) ger.add(g.nomegerente);
      for (const s of g.supervisores || []) if (s.nomesupervisor) sup.add(s.nomesupervisor);
    }
    const alvos = this._alvosDeAbertura(cubo);
    const tarefas = [];
    for (const a of alvos) {
      for (const n of ger) tarefas.push({ periodo: a.periodo, filtros: { ger: [n], anomes: [a.anomes] } });
      for (const n of sup) tarefas.push({ periodo: a.periodo, filtros: { sup: [n], anomes: [a.anomes] } });
    }
    const inicio = Date.now();
    let ok = 0, falhas = 0;
    // Mês virou (ou hierarquia mudou): os alvos antigos deixam de ser protegidos.
    PREWARM_KEYS.clear();
    tarefas.forEach(t => PREWARM_KEYS.add(this._chave(t.periodo, t.filtros)));
    // Ciclo novo = dado novo. NÃO apaga antes de consultar: quem logar durante o
    // prewarm continua recebendo o escopo do ciclo anterior na hora; a entrada só é
    // trocada quando a nova consulta termina.
    for (const t of tarefas) {
      try {
        await this._consultarChave(t.periodo, t.filtros);
        ok++;
      } catch (e) { falhas++; console.warn('[recorte prewarm]', JSON.stringify(t.filtros), e.message); }
    }
    console.log(`[recorte prewarm] ${ok}/${tarefas.length} escopos prontos em ${((Date.now() - inicio) / 1000).toFixed(0)}s${falhas ? ` (${falhas} falha(s))` : ''}`);
    await this._gravarPrewarm(tarefas.map(t => this._chave(t.periodo, t.filtros)));
  }

  // getScope ignorando o cache (mas compartilhando consulta em voo): recalcula e grava.
  async _consultarChave(periodoKey, filtros) {
    const key = this._chave(periodoKey, filtros);
    const ativos = CAMPOS.filter(c => filtros[c.key]).map(c => ({ ...c, vals: filtros[c.key] }));
    if (emVoo.has(key)) return emVoo.get(key);
    const p = this._consultar(this._periodo(periodoKey), ativos, key).finally(() => emVoo.delete(key));
    emVoo.set(key, p);
    return p;
  }

  // Mesma chave de getScope (os alvos do prewarm só usam ger/sup + anomes).
  _chave(periodoKey, filtros) {
    return periodoKey + '|' + Object.keys(filtros)
      .map(k => `${k}=${filtros[k].slice().sort().join('~')}`)
      .sort().join('&');
  }

  async _gravarPrewarm(chaves) {
    try {
      const entradas = chaves.map(k => [k, cache.get(k)]).filter(([, v]) => v);
      await fsp.mkdir(path.dirname(ARQ_PREWARM), { recursive: true });
      await fsp.writeFile(ARQ_PREWARM, JSON.stringify(entradas));
    } catch (e) { console.warn('[recorte prewarm] não gravado em disco:', e.message); }
  }

  // No boot da API: devolve ao cache o pré-aquecimento do último ciclo, se ainda
  // dentro do TTL — login logo após um restart não paga o recorte frio.
  async carregarPrewarm() {
    try {
      const entradas = JSON.parse(await fsp.readFile(ARQ_PREWARM, 'utf8'));
      let n = 0;
      for (const [k, v] of entradas) {
        if (v && v.dados && Date.now() - v.em <= TTL_PREWARM_MS) { PREWARM_KEYS.add(k); cacheSet(k, v.dados, v.em); n++; }
      }
      if (n) console.log(`[recorte prewarm] ${n} escopo(s) restaurados do disco`);
    } catch (e) { /* sem arquivo ainda */ }
  }

  // Vendas por Dia da Semana (cascata Dia → Categoria → Top 10 Produtos),
  // recortada por Gerente/Supervisor/Vendedor — mesmo raciocínio de getScope()
  // (reaproveita BASE_CTE com WHERE dinâmico), mas SEMPRE sobre os últimos 90
  // dias corridos até hoje (não usa período/mês do filtro de Período — mesmo
  // racional "sempre até hoje" do cubo principal _buildDowCascata do ETL, que
  // esta função espelha para o caso COM filtro de hierarquia).
  // filtros: { ger:[], sup:[], vend:[] }
  async getDowCascata(filtros) {
    const campos = CAMPOS_INTERNOS.filter(c => ['ger', 'sup', 'vend'].includes(c.key));
    const ativos = [];
    for (const campo of campos) {
      const vals = filtros[campo.key];
      if (!Array.isArray(vals) || !vals.length) continue;
      const txt = [...new Set(vals.map(v => String(v)).filter(Boolean))];
      if (txt.length) ativos.push({ ...campo, vals: txt });
    }
    if (!ativos.length) throw new Error('nenhum filtro informado');

    const hoje = new Date();
    const iniJanela = new Date(hoje); iniJanela.setDate(iniJanela.getDate() - 89);
    const fmt = dt => dt.toISOString().slice(0, 10);
    const [iniStr, fimStr] = [fmt(iniJanela), fmt(hoje)];

    const key = `dow|${iniStr}|${fimStr}|` + ativos.map(a => `${a.key}=${a.vals.slice().sort().join('~')}`).sort().join('&');
    const hit = cacheGet(key);
    if (hit) return hit;

    const params = [iniStr, fimStr];
    const cond = a => { params.push(a.vals); return `${a.expr} = ANY($${params.length}::${a.tipo})`; };
    const internos = ativos.map(cond);
    if (!ETL.BASE_CTE.includes(ANCHOR)) throw new Error('âncora do filtro não encontrada no BASE_CTE');
    const cte = ETL.BASE_CTE.replace(ANCHOR, `${ANCHOR}\n    and ${internos.join('\n    and ')}`);

    const rows = (await db.query(`
      SELECT EXTRACT(ISODOW FROM DataPed)::int dow, categoria, Codigo codigo, Descricao produto,
             SUM(Total) r, SUM(customedio) c, SUM(Qtde) q
      FROM (${cte}) s
      WHERE categoria IS NOT NULL AND Descricao IS NOT NULL AND EXTRACT(ISODOW FROM DataPed) BETWEEN 1 AND 5
      GROUP BY dow, categoria, Codigo, Descricao
    `, params)).rows;

    const porDow = { 1: {}, 2: {}, 3: {}, 4: {}, 5: {} };
    for (const row of rows) {
      const catMap = porDow[row.dow][row.categoria] || (porDow[row.dow][row.categoria] = []);
      catMap.push({ codigo: String(row.codigo), nome: row.produto, r: round2(num(row.r)), c: round2(num(row.c)), q: round2(num(row.q)) });
    }
    for (const dow in porDow) for (const cat in porDow[dow]) {
      porDow[dow][cat].sort((a, b) => b.r - a.r);
      porDow[dow][cat] = porDow[dow][cat].slice(0, 10);
    }
    const dados = { janela: { inicio: iniStr, fim: fimStr }, porDow };
    cacheSet(key, dados);
    return dados;
  }
}

module.exports = new DashboardRecorteService();

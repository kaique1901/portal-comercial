// ── ESCOPO DE ACESSO NO SERVIDOR ──────────────────────────────────────────────
// Antes, /full mandava o cubo da EMPRESA INTEIRA para qualquer navegador e a trava
// de Gerente/Supervisor existia só na tela (applyAccessLock em app.js) — bastava
// abrir o DevTools para ver tudo. Aqui o servidor decide o que cada sessão recebe:
//   • admin (DIRETORIA)  → tudo, como antes;
//   • gerente            → o próprio gerente + supervisores e vendedores dele;
//   • supervisor         → o próprio supervisor + vendedores dele.
// Nada é recalculado no banco: o recorte usa os cubos por hierarquia que o ETL já
// monta (hier_*, realizado_por_mes, meta por entidade...). O que só existe no nível
// EMPRESA e não tem equivalente por hierarquia é esvaziado — o front, para quem tem
// trava, já lê esses números do /recorte (que também é forçado ao escopo).

const NIVEIS = ['gerente', 'supervisor', 'vendedor'];
const ehPeriodo = k => /^\d{4}_[12]$/.test(k);

// ── Resolução: código da sessão → nomes permitidos ───────────────────────────
// Memo por objeto de cache (o ETL troca o objeto a cada publicação).
const memoEscopo = new WeakMap();

function universo(cache) {
  const ger = new Set(), sup = new Set(), vend = new Set();
  for (const k of Object.keys(cache)) {
    if (!ehPeriodo(k)) continue;
    const d = cache[k] || {};
    Object.keys(d.por_gerente || {}).forEach(n => ger.add(n));
    Object.keys(d.por_supervisor || {}).forEach(n => sup.add(n));
    Object.keys(d.full_vendedores || {}).forEach(n => vend.add(n));
    const m = d.meta || {};
    Object.keys(m.por_gerente || {}).forEach(n => ger.add(n));
    Object.keys(m.por_supervisor || {}).forEach(n => sup.add(n));
    Object.keys(m.por_vendedor || {}).forEach(n => vend.add(n));
  }
  for (const g of ((cache._hierarquia || {}).gerentes || [])) {
    if (g.nomegerente) ger.add(g.nomegerente);
    for (const s of g.supervisores || []) {
      if (s.nomesupervisor) sup.add(s.nomesupervisor);
      for (const v of s.vendedores || []) if (v.nomven) vend.add(v.nomven);
    }
  }
  const est = cache._estoque || {};
  Object.values(est.vendedor_info || {}).forEach(vi => {
    if (vi.gerente) ger.add(vi.gerente); if (vi.supervisor) sup.add(vi.supervisor); if (vi.vendedor) vend.add(vi.vendedor);
  });
  const inad = cache._inadimplencia || {};
  Object.keys(inad.por_gerente || {}).forEach(n => ger.add(n));
  Object.keys(inad.por_supervisor || {}).forEach(n => sup.add(n));
  Object.keys(inad.por_vendedor || {}).forEach(n => vend.add(n));
  return { ger, sup, vend, todos: new Set([...ger, ...sup, ...vend]) };
}

// sessao: { role, cod }. Devolve null para admin (sem restrição), ou o escopo.
// Lança Error com .status=403 se o código não existe no cadastro.
function resolver(cache, sessao) {
  if (!sessao || sessao.role === 'admin') return null;
  let porCache = memoEscopo.get(cache);
  if (!porCache) { porCache = new Map(); memoEscopo.set(cache, porCache); }
  const chave = `${sessao.role}:${sessao.cod}`;
  if (porCache.has(chave)) return porCache.get(chave);

  const hier = (cache._hierarquia || {}).gerentes || [];
  const cod = String(sessao.cod);
  let gerNome = null, supNome = null;
  const sups = new Set(), vends = new Set();
  const periodos = Object.keys(cache).filter(ehPeriodo).map(k => cache[k] || {});

  if (sessao.role === 'gerente') {
    const g = hier.find(x => String(x.codgerente) === cod);
    if (!g || !g.nomegerente) { const e = new Error('gerente sem cadastro ativo'); e.status = 403; throw e; }
    gerNome = g.nomegerente;
    (g.supervisores || []).forEach(s => { if (s.nomesupervisor) sups.add(s.nomesupervisor); });
    periodos.forEach(d => Object.entries(d.por_supervisor || {}).forEach(([n, v]) => { if (v && v.gerente === gerNome) sups.add(n); }));
  } else if (sessao.role === 'supervisor') {
    for (const g of hier) {
      const s = (g.supervisores || []).find(x => String(x.codsupervisor) === cod);
      if (s) { supNome = s.nomesupervisor; gerNome = g.nomegerente; break; }
    }
    if (!supNome) { const e = new Error('supervisor sem cadastro ativo'); e.status = 403; throw e; }
    sups.add(supNome);
  } else {
    const e = new Error('cargo inválido'); e.status = 403; throw e;
  }
  // Vendedores: cadastro (hierarquia) ∪ quem vendeu sob esses supervisores no cubo.
  for (const g of hier) for (const s of g.supervisores || []) {
    if (sups.has(s.nomesupervisor)) (s.vendedores || []).forEach(v => { if (v.nomven) vends.add(v.nomven); });
  }
  periodos.forEach(d => Object.entries(d.full_vendedores || {}).forEach(([n, v]) => { if (v && sups.has(v.supervisor)) vends.add(n); }));

  const u = universo(cache);
  const permitidos = new Set([...sups, ...vends]);
  if (sessao.role === 'gerente') permitidos.add(gerNome);
  // Mesmo nome em dois níveis (ex.: "CIFAL COMERCIAL DE TABACOS" é supervisor E
  // vendedor de outra equipe) não pode furar a barreira: o nome só é liberado se for
  // do escopo — e um vendedor homônimo de outro time some junto. Preferimos esconder
  // a mais do que mostrar dado de outra equipe.
  const esc = {
    role: sessao.role, cod, gerNome, supNome,
    nivel: sessao.role,                       // grão do cubo hier_* usado nos agregados
    nome: sessao.role === 'gerente' ? gerNome : supNome,
    sups, vends, permitidos, universo: u.todos,
    chave,
  };
  porCache.set(chave, esc);
  return esc;
}

// ── Poda genérica ────────────────────────────────────────────────────────────
// Remove de qualquer estrutura as entradas de entidades (gerente/supervisor/
// vendedor) fora do escopo:
//   • dicionário cujas chaves são majoritariamente nomes de entidade → só ficam as
//     chaves permitidas (as não-entidade, como "(sem vendedor no cadastro)", saem);
//   • registro com campo gerente/supervisor/vendedor de outra equipe → sai;
//   • lista de nomes (strings) → saem os nomes de entidade fora do escopo.
const CAMPOS_ENT = ['gerente', 'supervisor', 'vendedor'];
function nomeDe(v) { return typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.nome === 'string' ? v.nome : null); }
// Dono de um registro (linha de cliente, título, vendedor...): decidido pelo campo
// do MESMO nível do cargo — `gerente` para gerente, `supervisor` para supervisor —
// e só na falta dele pelo nível abaixo. Assim um título lançado no supervisor S21
// continua dele mesmo que o vendedor da linha hoje seja de outra equipe, e um
// vendedor homônimo de outro time não puxa a linha para fora. O vendedor pode vir
// como texto ou como objeto {nome, supervisor, gerente} (ex.: _abcd90).
function hierDoRegistro(x) {
  const v = x.vendedor;
  const vObj = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  return {
    ger: typeof x.gerente === 'string' ? x.gerente : (vObj && typeof vObj.gerente === 'string' ? vObj.gerente : null),
    sup: typeof x.supervisor === 'string' ? x.supervisor : (vObj && typeof vObj.supervisor === 'string' ? vObj.supervisor : null),
    vend: nomeDe(v),
  };
}
function registroBloqueado(x, esc) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  if (!CAMPOS_ENT.some(c => c in x)) return false;
  const { ger, sup, vend } = hierDoRegistro(x);
  const vendForaDoEscopo = vend != null && esc.universo.has(vend) && !esc.vends.has(vend);
  if (esc.role === 'gerente') {
    if (ger != null) return ger !== esc.gerNome;
    if (sup != null) return !esc.sups.has(sup);
    return vendForaDoEscopo;
  }
  if (sup != null) return sup !== esc.supNome;
  if (vend != null) return vendForaDoEscopo;
  if (ger != null) return ger !== esc.gerNome;   // registro só com gerente: o do próprio chefe
  return false;
}
function podar(o, esc) {
  if (Array.isArray(o)) {
    const out = [];
    for (const x of o) {
      if (typeof x === 'string') { if (esc.universo.has(x) && !esc.permitidos.has(x)) continue; out.push(x); continue; }
      if (registroBloqueado(x, esc)) continue;
      out.push(x && typeof x === 'object' ? podar(x, esc) : x);
    }
    return out;
  }
  if (!o || typeof o !== 'object') return o;
  const ks = Object.keys(o);
  const ents = ks.filter(k => esc.universo.has(k));
  const dictEntidade = ents.length > 0 && ents.length * 2 >= ks.length;
  const out = {};
  for (const k of ks) {
    if (dictEntidade && !esc.permitidos.has(k)) continue;
    const v = o[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && registroBloqueado(v, esc)) continue;
    out[k] = (v && typeof v === 'object') ? podar(v, esc) : v;
  }
  return out;
}

// Esvazia mantendo o tipo (o front lê muitos campos sem checar existência).
function vazio(v) {
  if (Array.isArray(v)) return [];
  if (v && typeof v === 'object') return {};
  if (typeof v === 'number') return 0;
  return v;
}

// ── Período (semestre) no escopo ─────────────────────────────────────────────
// Campos por entidade → podados. Agregados da empresa que têm equivalente por
// hierarquia → reconstruídos para a entidade do usuário. Todo o resto (agregados
// só de empresa: canal, status, grupo, cascata, Top 50 por mês...) → vazio; para
// usuário com trava o front lê esses números do /recorte.
const CAMPOS_ENTIDADE = new Set(['por_gerente', 'por_supervisor', 'full_vendedores', 'realizado_por_mes', 'realizado_fumokg',
  'top_vendedores', 'top_vendedores_cash', 'top_vendedores_margem']);
const MANTER = new Set(['label', 'janela90']);

function somaDias(dicts) {
  const out = {};
  dicts.forEach(dd => Object.entries(dd || {}).forEach(([dia, v]) => {
    const a = out[dia] || (out[dia] = [0, 0]); a[0] += v[0] || 0; a[1] += v[1] || 0;
  }));
  return out;
}

function periodoNoEscopo(d, esc) {
  const out = {};
  for (const k of Object.keys(d)) {
    if (MANTER.has(k)) out[k] = d[k];
    else if (CAMPOS_ENTIDADE.has(k) || k.startsWith('hier_')) out[k] = podar(d[k], esc);
    else out[k] = vazio(d[k]);
  }
  // Meta: por entidade fica (podada); por categoria/mês da EMPRESA sai.
  if (d.meta) {
    const m = d.meta;
    out.meta = podar({
      linhas: m.linhas,
      por_gerente: m.por_gerente, por_supervisor: m.por_supervisor, por_vendedor: m.por_vendedor,
      por_mes: m.por_mes, hier_por_mes_categoria: m.hier_por_mes_categoria,
    }, esc);
    for (const k of Object.keys(m)) if (!(k in out.meta)) out.meta[k] = vazio(m[k]);
  }
  if (d.bonificacao) out.bonificacao = { ...vazio(d.bonificacao), hier: podar(d.bonificacao.hier || {}, esc), por_mes_categoria: {} };

  // Agregados reconstruídos para a entidade do usuário (nível do cargo).
  const L = esc.nivel, N = esc.nome;
  const ent = L === 'gerente' ? (d.por_gerente || {})[N] : (d.por_supervisor || {})[N];
  const hier = campo => ((d[campo] || {})[L] || {})[N];
  if (ent) {
    out.receita = ent.r || 0; out.custo = ent.c || 0; out.qtde = ent.q != null ? ent.q : 0;
    out.margem_geral = out.receita > 0 ? +(100 * (1 - out.custo / out.receita)).toFixed(2) : 0;
  }
  out.n_ger = L === 'gerente' ? 1 : 0;
  out.n_sup = Object.keys(out.por_supervisor || {}).length;
  out.n_vend = Object.keys(out.full_vendedores || {}).length;
  // por_mes: mantém os MESMOS meses do cubo (a lista de meses do filtro sai daqui)
  // com o realizado da entidade (realizado_por_mes[mes][nível][nome]).
  out.por_mes = {};
  for (const mes of Object.keys(d.por_mes || {})) {
    const x = ((((d.realizado_por_mes || {})[mes] || {})[L]) || {})[N];
    const r = x ? x.r || 0 : 0, c = x ? x.c || 0 : 0;
    out.por_mes[mes] = { r, c, q: null, m: r > 0 ? +(100 * (1 - c / r)).toFixed(2) : 0, pedidos: null };
  }
  const cat = hier('hier_por_categoria'); if (cat) out.por_categoria = cat;
  const topCli = hier('hier_top_clientes'); if (topCli) out.top_clientes = topCli;
  const topProd = hier('hier_top_produtos'); if (topProd) out.top_produtos = topProd;
  const abcd = hier('hier_abcd'); if (abcd) out.abcd = abcd;
  const pag = hier('hier_pagamento_por_categoria'); if (pag) out.pagamento_por_categoria = pag;
  // Grão diário só existe por Gerente no cubo; supervisor fica sem (o recorte cobre).
  if (L === 'gerente') {
    out.por_dia = somaDias([((d.hier_por_dia || {}).gerente || {})[N]]);
    out.por_dia_categoria = ((d.hier_por_dia_categoria || {}).gerente || {})[N] || {};
  }
  return out;
}

// ── Extras (_inadimplencia, _estoque, ...) no escopo ─────────────────────────
function inadNoEscopo(inad, esc) {
  const out = podar(inad, esc);
  const t = { clientes: 0, titulos: 0, saldo: 0, f0_30: 0, f31_90: 0, f91_365: 0, f365_mais: 0 };
  (out.clientes || []).forEach(c => {
    t.clientes++; t.titulos += c.titulos || 0; t.saldo += c.saldo || 0;
    t.f0_30 += c.f0_30 || 0; t.f31_90 += c.f31_90 || 0; t.f91_365 += c.f91_365 || 0; t.f365_mais += c.f365_mais || 0;
  });
  Object.keys(t).forEach(k => { if (k !== 'clientes' && k !== 'titulos') t[k] = Math.round(t[k] * 100) / 100; });
  out.total = t;
  return out;
}
function semCompraNoEscopo(sc, esc) {
  const clientes = podar(sc.clientes || [], esc);
  const cods = new Set(clientes.map(c => String(c.codigo)));
  const cat = {};
  Object.entries(sc.categorias_por_cliente || {}).forEach(([cod, v]) => { if (cods.has(String(cod))) cat[cod] = v; });
  return { ...sc, clientes, categorias_por_cliente: cat, total: clientes.length };
}
function estoqueNoEscopo(est, esc) {
  const vi = {};
  Object.entries(est.vendedor_info || {}).forEach(([cod, info]) => {
    if (info && !registroBloqueado(info, esc)) vi[cod] = info;
  });
  const detalhe = (est.detalhe || []).filter(row => vi[String(row[0])]);
  // por_produto é o "cadastro" que dá nome/categoria às linhas: mantém só os produtos
  // das linhas do escopo e só os campos descritivos (sem saldo/venda da empresa).
  const prods = new Set(detalhe.map(r => String(r[1])));
  const porProduto = {};
  Object.entries(est.por_produto || {}).forEach(([cod, p]) => {
    if (!prods.has(String(cod))) return;
    const meta = {}; Object.entries(p || {}).forEach(([k, v]) => { if (typeof v !== 'number') meta[k] = v; });
    porProduto[cod] = meta;
  });
  const out = {};
  for (const k of Object.keys(est)) out[k] = vazio(est[k]);
  Object.assign(out, {
    dias_uteis_90: est.dias_uteis_90, janela_venda_90: est.janela_venda_90,
    vendedor_info: vi, detalhe, por_produto: porProduto,
    linhas: detalhe.length, linhas_com_saldo: detalhe.filter(r => (r[2] || 0) > 0).length,
    por_gerente: podar(est.por_gerente || {}, esc), por_supervisor: podar(est.por_supervisor || {}, esc), por_vendedor: podar(est.por_vendedor || {}, esc),
    por_gerente_categoria: podar(est.por_gerente_categoria || {}, esc),
    por_supervisor_categoria: podar(est.por_supervisor_categoria || {}, esc),
    por_vendedor_categoria: podar(est.por_vendedor_categoria || {}, esc),
  });
  // Supervisor não enxerga o total do gerente dele.
  if (esc.role === 'supervisor') { out.por_gerente = {}; out.por_gerente_categoria = {}; }
  return out;
}
function abcd90NoEscopo(a, esc) {
  const clientes = (a.clientes || []).filter(c => c && !registroBloqueado(c, esc));
  const cods = new Set(clientes.map(c => String(c.codigo)));
  const cc = {};
  Object.entries(a.clientes_categoria || {}).forEach(([cod, v]) => { if (cods.has(String(cod))) cc[cod] = v; });
  return { ...a, clientes, clientes_categoria: cc };
}
function hierarquiaNoEscopo(h, esc) {
  const gerentes = [];
  for (const g of (h && h.gerentes) || []) {
    if (g.nomegerente !== esc.gerNome) continue;
    const sups = (g.supervisores || []).filter(s => esc.sups.has(s.nomesupervisor)).map(s => ({
      codsupervisor: s.codsupervisor, nomesupervisor: s.nomesupervisor, codgerente: s.codgerente,
      // Sem CPF, e-mail e celular: o front não usa e não precisa sair do servidor.
      vendedores: (s.vendedores || []).map(v => ({ codven: v.codven, nomven: v.nomven, ativo: v.ativo, apelido: v.apelido })),
    }));
    gerentes.push({ codgerente: g.codgerente, nomegerente: g.nomegerente, supervisores: sups });
  }
  return { ...h, gerentes };
}

// Supervisor não pode receber os números do GERENTE dele (totais do time todo),
// mas o front precisa do nome do gerente para montar a árvore — ele vem em
// por_supervisor[].gerente / _hierarquia, não nos dicionários por gerente.
function tirarNivelGerente(per) {
  ['por_gerente'].forEach(k => { if (per[k]) per[k] = {}; });
  for (const k of Object.keys(per)) {
    const v = per[k];
    if (k.startsWith('hier_') && v && typeof v === 'object' && v.gerente) per[k] = { ...v, gerente: {} };
  }
  if (per.realizado_fumokg) per.realizado_fumokg = { ...per.realizado_fumokg, por_gerente: {} };
  if (per.realizado_por_mes) for (const mes of Object.keys(per.realizado_por_mes)) per.realizado_por_mes[mes] = { ...per.realizado_por_mes[mes], gerente: {} };
  if (per.meta) {
    per.meta.por_gerente = {};
    if (per.meta.por_mes) for (const mes of Object.keys(per.meta.por_mes)) per.meta.por_mes[mes] = { ...per.meta.por_mes[mes], gerente: {} };
    if (per.meta.hier_por_mes_categoria) per.meta.hier_por_mes_categoria = { ...per.meta.hier_por_mes_categoria, gerente: {} };
  }
  if (per.bonificacao && per.bonificacao.hier) per.bonificacao.hier = { ...per.bonificacao.hier, gerente: {} };
}

const memoFull = new WeakMap();
function fullNoEscopo(cache, esc, montarBase) {
  let porCache = memoFull.get(cache);
  if (!porCache) { porCache = new Map(); memoFull.set(cache, porCache); }
  if (porCache.has(esc.chave)) return porCache.get(esc.chave);
  const base = montarBase(cache);
  const out = {};
  for (const k of Object.keys(base)) {
    const v = base[k];
    if (ehPeriodo(k) && v && typeof v === 'object') {
      out[k] = periodoNoEscopo(v, esc);
      if (esc.role === 'supervisor') tirarNivelGerente(out[k]);
    }
    else if (k === '_inadimplencia' && v) out[k] = inadNoEscopo(v, esc);
    else if (k === '_clientesSemCompra60' && v) out[k] = semCompraNoEscopo(v, esc);
    else if (k === '_estoque' && v) out[k] = estoqueNoEscopo(v, esc);
    else if (k === '_abcd90' && v) out[k] = abcd90NoEscopo(v, esc);
    else if (k === '_hierarquia' && v) out[k] = hierarquiaNoEscopo(v, esc);
    else if (k === '_etl') out[k] = v;
    else if (k.startsWith('_')) out[k] = vazio(v);   // _dowCascata e futuros extras de empresa
    else out[k] = v;
  }
  if (esc.role === 'supervisor' && out._inadimplencia) {
    out._inadimplencia.por_gerente = {};
  }
  porCache.set(esc.chave, out);
  return out;
}

// mix_cascata_detalhe (por código de cliente): só os clientes dos vendedores do escopo.
function mixNoEscopo(cache, periodo, detalhe, esc) {
  const d = cache[periodo] || {};
  const cods = new Set();
  Object.entries(d.hier_top_clientes_vendedor_top50 || {}).forEach(([vend, lista]) => {
    if (esc.permitidos.has(vend)) (lista || []).forEach(c => cods.add(String(c.codigo)));
  });
  ((cache._abcd90 || {}).clientes || []).forEach(c => { if (c && !registroBloqueado(c, esc)) cods.add(String(c.codigo)); });
  const out = {};
  Object.entries(detalhe || {}).forEach(([cod, v]) => { if (cods.has(String(cod))) out[cod] = v; });
  return out;
}

// Filtros de hierarquia FORÇADOS no /recorte e no /dow-cascata. Devolve os filtros
// ajustados ou lança 403 se o pedido só tinha entidades de fora do escopo.
function forcarFiltros(filtros, esc) {
  if (!esc) return filtros;
  const f = { ...filtros };
  const proibido = () => { const e = new Error('fora do seu escopo de acesso'); e.status = 403; return e; };
  const restringir = (k, permitidos) => {
    if (!f[k]) return;
    const ok = f[k].filter(n => permitidos.has(n));
    if (!ok.length) throw proibido();
    f[k] = ok;
  };
  if (esc.role === 'gerente') {
    if (f.ger && !f.ger.includes(esc.gerNome)) throw proibido();
    f.ger = [esc.gerNome];
    restringir('sup', esc.sups);
    restringir('vend', esc.vends);
  } else {
    if (f.ger && !f.ger.includes(esc.gerNome)) throw proibido();
    if (f.sup && !f.sup.includes(esc.supNome)) throw proibido();
    delete f.ger;
    f.sup = [esc.supNome];
    restringir('vend', esc.vends);
  }
  return f;
}

module.exports = { resolver, fullNoEscopo, mixNoEscopo, forcarFiltros };

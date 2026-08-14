// ════════════════════════════════════════════════════════════════
// app.js — Portal Comercial Executivo
// TODOS os dados vêm da API (endpoint /full), que agrega direto do
// banco PostgreSQL. Nada é lido de planilha nem de arquivo estático.
//
// LIMITAÇÃO CONHECIDA: recortes por Top-N (Top 50 por dimensão) são
// pré-agregados na API. Combinar dimensões DIFERENTES ao mesmo tempo
// usa a dimensão mais específica e avisa na tela.
// ════════════════════════════════════════════════════════════════

const MESES_NOME = {1:"Jan",2:"Fev",3:"Mar",4:"Abr",5:"Mai",6:"Jun",7:"Jul",8:"Ago",9:"Set",10:"Out",11:"Nov",12:"Dez"};
// Paleta monocromática (família de verdes) — varia luminosidade/leve rotação de
// matiz (verde→musgo→lima) para manter categorias distinguíveis num pizza/barra.
const P = ["#0d5c3a","#1f7a52","#2f9468","#3fae7e","#5ec695","#0f4a30","#4ba87a","#79c49a","#1c6b48","#6fbf8f","#2a8a5c","#95d4b0"];
const C = {acc:"#1f7a52",acc2:"#2f9468",acc3:"#0d5c3a",up:"#22875a",dn:"#b3261e",t2:"#52685c",t3:"#85978c"};
Chart.defaults.color = "#54695f";
Chart.defaults.font.family = "'Segoe UI',system-ui,sans-serif";
Chart.defaults.font.size = 11;

// ── FONTE DE DADOS: 100% via API ─────────────────────────────────
window.API_BASE_URL = window.API_BASE_URL || `http://${window.location.hostname}:4001/api/v1/dashboard`;
window.REAL_DATA = {};

// ── TEMA CLARO / ESCURO ──────────────────────────────────────────
// Default = claro (verde). O toggle aplica [data-theme="dark"] no <html>; cores
// vêm das CSS variables. Persiste no localStorage. Charts acompanham.
function currentTheme(){ return document.documentElement.getAttribute('data-theme')==='dark' ? 'dark' : 'light'; }
function applyChartTheme(){
  const dark = currentTheme()==='dark';
  Chart.defaults.color = dark ? '#a8c2b1' : '#54695f';
  Chart.defaults.borderColor = dark ? 'rgba(255,255,255,.08)' : 'rgba(16,36,26,.08)';
}
function setTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('portal-theme', t); } catch(e){}
  const btn = document.getElementById('themeTog'); if (btn) btn.textContent = (t==='dark' ? '☀️' : '🌙');
  applyChartTheme();
  if (window.REAL_DATA && Object.keys(REAL_DATA).length) { try { renderAll(); } catch(e){} }
}
function toggleTheme(){ setTheme(currentTheme()==='dark' ? 'light' : 'dark'); }
(function(){ let t='light'; try { t = localStorage.getItem('portal-theme') || 'light'; } catch(e){} document.documentElement.setAttribute('data-theme', t); })();

const fM = v => { v=v||0; if (Math.abs(v)>=1e6) return "R$ "+(v/1e6).toFixed(1)+"M"; if (Math.abs(v)>=1e3) return "R$ "+(v/1e3).toFixed(0)+"K"; return "R$ "+v.toFixed(0); };
const fF = v => "R$ "+Math.round(v||0).toLocaleString("pt-BR");
const fN = v => Math.round(v||0).toLocaleString("pt-BR");
const fPct = v => (v==null?"—":v.toFixed(1)+"%");
const fDelta = (a,b) => { if (!b) return {s:"—",c:"neu"}; const d=(a-b)/b*100; return {s:(d>=0?"▲ +":"▼ ")+Math.abs(d).toFixed(1)+"%", c:d>=0?"up":"dn"}; };
// pill compacto para usar dentro de células de tabela — "sem hist." quando a
// entidade não existir no período anterior (comum p/ Top-N: só top 50 embutido).
function deltaPillSmall(cur, prev){
  if (prev==null) return '<span class="delta-pill neu">sem hist.</span>';
  if (prev===0) return '<span class="delta-pill neu">—</span>';
  const d = (cur-prev)/prev*100;
  return `<span class="delta-pill ${d>=0?'up':'dn'}">${d>=0?'▲':'▼'} ${Math.abs(d).toFixed(1)}%</span>`;
}
// delta em pontos percentuais p/ métricas que já são % (ex.: qualidade dos dados)
function deltaPP(curPct, prevPct, lowerIsBetter){
  if (prevPct==null) return '<span class="delta-pill neu">sem base</span>';
  const diff = curPct - prevPct;
  const good = lowerIsBetter ? diff<=0 : diff>=0;
  return `<span class="delta-pill ${good?'up':'dn'}">${diff>=0?'+':''}${diff.toFixed(2)} p.p.</span>`;
}
function periodAsScope(p){ return p ? {r:p.receita, c:p.custo, q:p.qtde} : null; }

// ── CUBO HIERÁRQUICO (Gerente/Supervisor/Vendedor x Cliente/Produto) ─────
// Rankings, Mix e ABCD usam isto para recortar por hierarquia com dados reais
// (Top 50 por entidade), em vez de mostrar sempre o Top 50 do período inteiro.
function hierLevelActive(){
  if (ST.vend.length) return 'vendedor';
  if (ST.sup.length) return 'supervisor';
  if (ST.ger.length) return 'gerente';
  return null;
}
function hierSelectedNames(level){
  return level==='vendedor' ? ST.vend : level==='supervisor' ? ST.sup : level==='gerente' ? ST.ger : [];
}
// Soma as listas Top-50 de cada entidade selecionada no nível mais específico ativo
// (ex.: 2 gerentes selecionados => une os dois Top-50 e soma o que coincidir).
function hierUnionTop(dictByLevel, level, names, topN){
  const merged = {};
  names.forEach(n=>{
    const list = dictByLevel[level][n];
    if (!list) return;
    list.forEach(item=>{
      if (!merged[item.codigo]) merged[item.codigo] = Object.assign({}, item);
      else { merged[item.codigo].r+=item.r; merged[item.codigo].c+=item.c; merged[item.codigo].q+=item.q; }
    });
  });
  const arr = Object.values(merged).map(x=>Object.assign({}, x, {m: x.r>0?+(100*(1-x.c/x.r)).toFixed(2):0}));
  arr.sort((a,b)=>b.r-a.r);
  return topN ? arr.slice(0,topN) : arr;
}
// Soma hier_por_categoria (level->nome->categoria->{r,c,q,m}) das entidades
// selecionadas no nível ativo — {categoria: {r,c,q,m}}. Usado por Margem/Cash
// (tabela por Categoria) e Riscos & Oportunidades quando há filtro de
// Gerente/Supervisor/Vendedor ativo, para não misturar com o total da empresa.
function hierUnionCategoria(d, level, names){
  const merged = {};
  const src = d.hier_por_categoria && d.hier_por_categoria[level];
  if (!src) return merged;
  names.forEach(n=>{
    const cats = src[n];
    if (!cats) return;
    Object.keys(cats).forEach(cat=>{
      if (!merged[cat]) merged[cat] = {r:0,c:0,q:0};
      merged[cat].r += cats[cat].r; merged[cat].c += cats[cat].c; merged[cat].q += cats[cat].q;
    });
  });
  Object.keys(merged).forEach(cat=>{ const x=merged[cat]; x.m = x.r>0 ? +(100*(1-x.c/x.r)).toFixed(2) : 0; });
  return merged;
}
// ── CASCATA DE ENTIDADE (Gerente → Supervisor → Vendedor) ────────────────
// Quando o usuário filtra um nível mais específico (Supervisor/Vendedor) SEM
// escolher explicitamente o nível pai (Gerente/Supervisor), as tabelas "por
// Gerente"/"por Supervisor" devem se restringir aos pais reais da seleção —
// e não continuar mostrando a empresa inteira naquele nível. Usa só campos já
// existentes (por_supervisor[].gerente, full_vendedores[].supervisor).
function gerenteDoSupervisor(d, supName){ 
  const s=d.por_supervisor[supName]; 
  if (s) return s.gerente;
  const h = window.REAL_DATA && REAL_DATA._hierarquia;
  if (h && Array.isArray(h.gerentes)) {
    for (const g of h.gerentes) {
      for (const sup of g.supervisores || []) {
        if (sup.nomesupervisor === supName) return g.nomegerente;
      }
    }
  }
  return null; 
}
function supervisorDoVendedor(d, vendName){ const v=d.full_vendedores[vendName]; return v?v.supervisor:null; }
function gerenteDoVendedor(d, vendName){ const sup=supervisorDoVendedor(d,vendName); return sup?gerenteDoSupervisor(d,sup):null; }

// Lista completa da força de vendas real: full_vendedores (com venda) + ativos do
// cadastro (REAL_DATA._hierarquia, via API) que ainda não venderam no período.
function vendedoresReais(d){
  const bySales = d.full_vendedores || {};
  const map = new Map();
  
  // Barreira de segurança: mesma resolução canônica de applyAccessLock (casa por
  // código/nome) para bater com as chaves reais do cubo. Leitura via pickCI porque
  // a API de auth devolve PascalCase (Vendedores/Supervisores).
  let allowedVends = null;
  let allowedSups = null;
  if (authSession) {
    const idx = buildCanonIndex();
    if (authSession.role === 'supervisor') {
      // vendedoresCarteira (resolvida na API) é a fonte mais confiável; cai p/ a
      // lista crua do login se ainda não foi carregada.
      const vc = Array.isArray(authSession.vendedoresCarteira) && authSession.vendedoresCarteira.length
        ? authSession.vendedoresCarteira.map(v => ({ codven: v.cod, nome: v.nome }))
        : pickCI(authSession, 'vendedores');
      if (Array.isArray(vc) && vc.length){
        allowedVends = new Set(vc.map(v => resolveVend(idx, v)).filter(Boolean).map(n => n.toUpperCase().trim()));
      }
    }
    if (authSession.role === 'gerente') {
      const sups = pickCI(authSession, 'supervisores');
      if (Array.isArray(sups) && sups.length){
        allowedSups = new Set(sups.map(s => resolveSup(idx, s)).filter(Boolean).map(n => n.toUpperCase().trim()));
      }
    }
  }

  Object.keys(bySales).forEach(n => {
    const sup = String(bySales[n].supervisor).toUpperCase().trim();
    const nm = String(n).toUpperCase().trim();
    
    // Barreira Rígida de Segurança
    if (allowedVends && !allowedVends.has(nm)) return;
    if (allowedSups && !allowedSups.has(sup)) return;

    map.set(n, bySales[n].supervisor);
  });
  
  const h = window.REAL_DATA && REAL_DATA._hierarquia;
  if (h && Array.isArray(h.gerentes)){
    const comVenda = new Set(Object.keys(bySales).map(n=>n.trim().toUpperCase()));
    h.gerentes.forEach(g=>(g.supervisores||[]).forEach(s=>{
      (s.vendedores||[]).forEach(v=>{
        if (!v || !v.nomven) return;
        const nm = String(v.nomven).trim();
        const nmU = nm.toUpperCase();
        const sup = String(s.nomesupervisor).toUpperCase().trim();
        
        // Barreira Rígida de Segurança para sem venda
        if (allowedVends && !allowedVends.has(nmU)) return;
        if (allowedSups && !allowedSups.has(sup)) return;
        
        if (!comVenda.has(nmU)) map.set(nm, s.nomesupervisor);
      });
    }));
  }
  return [...map.entries()].map(([nome,supervisor])=>({ nome, supervisor }));
}

// ── TRAVA DE ACESSO: resolução de nomes canônicos ───────────────────────────
// A API de auth (apis.cifaldistribuidora.com.br:8001) é um sistema EXTERNO e
// separado do cubo (Postgres). O nome/formato que ela devolve p/ supervisor e
// vendedor pode divergir das CHAVES do cubo (que vêm prefixadas: "S15 - GUSTAVO…",
// "G01 - EDUARDO"). Os filtros ST.sup/ST.vend usam igualdade estrita, então
// precisamos mapear o que o auth devolve → chave exata do cubo. Casamos primeiro
// por CÓDIGO (codven/codsupervisor, imunes a formatação) e, na falta, por nome
// caixa-alta/trim. Índice montado a partir do cadastro real (_hierarquia).
function buildCanonIndex(){
  const idx = { gerByCod:new Map(), gerByName:new Map(), supByCod:new Map(), supByName:new Map(), vendByCod:new Map(), vendByName:new Map() };
  const h = window.REAL_DATA && REAL_DATA._hierarquia;
  if (h && Array.isArray(h.gerentes)){
    for (const g of h.gerentes){
      const gn = g.nomegerente;
      if (gn){ idx.gerByName.set(String(gn).toUpperCase().trim(), gn); if (g.codgerente!=null) idx.gerByCod.set(String(g.codgerente), gn); }
      for (const s of (g.supervisores||[])){
        const sn = s.nomesupervisor;
        if (sn){ idx.supByName.set(String(sn).toUpperCase().trim(), sn); if (s.codsupervisor!=null) idx.supByCod.set(String(s.codsupervisor), sn); }
        for (const v of (s.vendedores||[])){
          const vn = v.nomven;
          if (vn){ idx.vendByName.set(String(vn).toUpperCase().trim(), vn); if (v.codven!=null) idx.vendByCod.set(String(v.codven), vn); }
        }
      }
    }
  }
  return idx;
}
function _resolveCanon(byCod, byName, codKeys, nameKeys, obj){
  if (obj==null) return null;
  if (typeof obj === 'object'){
    // Acesso case-insensitive: o auth usa camelCase (codSupervisor/codVendedor)
    // e o cubo usa minúsculo — normalizamos as chaves do objeto p/ casar ambos.
    const lk = {}; for (const k in obj) lk[k.toLowerCase()] = obj[k];
    for (const ck of codKeys){ const c=lk[ck.toLowerCase()]; if (c!=null && byCod.has(String(c))) return byCod.get(String(c)); }
    let nm=null; for (const nk of nameKeys){ const val=lk[nk.toLowerCase()]; if (val!=null){ nm=val; break; } }
    obj = nm;
  }
  if (obj==null) return null;
  return byName.get(String(obj).toUpperCase().trim()) || String(obj);
}
// codKeys/nameKeys cobrem os nomes do cubo E os do auth (codVendedor/codSupervisor);
// o lookup em _resolveCanon é case-insensitive, então basta listar em minúsculo.
const resolveGer  = (idx,o)=>_resolveCanon(idx.gerByCod, idx.gerByName, ['codgerente','codger','cod'], ['gerente','nomegerente','nome'], o);
const resolveSup  = (idx,o)=>_resolveCanon(idx.supByCod, idx.supByName, ['codsupervisor','codsup','cod'], ['supervisor','nomesupervisor','nome'], o);
const resolveVend = (idx,o)=>_resolveCanon(idx.vendByCod, idx.vendByName, ['codvendedor','codven','codvend','cod'], ['vendedor','nomven','nome'], o);

// Aplica a trava conforme o cargo logado, gravando SEMPRE chaves canônicas do cubo.
function applyAccessLock(){
  if (!authSession) return;
  const idx = buildCanonIndex();
  if (authSession.role === 'gerente'){
    // Passa o próprio authSession p/ casar por código (codGerente) + nome.
    const ger = resolveGer(idx, authSession);
    if (ger) ST.ger = [ger];
    // Níveis abaixo começam DESMARCADOS (= todos, dentro do escopo do gerente).
    ST.sup = [];
    ST.vend = [];
  } else if (authSession.role === 'supervisor'){
    // authSession tem codSupervisor + supervisor no topo — casa por código primeiro.
    let sup = resolveSup(idx, authSession);
    if (!sup){
      // Sem supervisor utilizável na sessão: deriva pelos vendedores dele.
      const vends = pickCI(authSession, 'vendedores');
      const d = curPeriod(); const fv = (d && d.full_vendedores) || {};
      const sset = new Set();
      (Array.isArray(vends) ? vends : []).map(v=>resolveVend(idx,v)).filter(Boolean)
        .forEach(n=>{ if (fv[n] && fv[n].supervisor) sset.add(fv[n].supervisor); });
      if (sset.size) ST.sup = [...sset];
    } else {
      ST.sup = [sup];
    }
    // Vendedor fica liberado e desmarcado (opções já restritas ao supervisor).
    ST.vend = [];
  }
}

// Carteira do usuário logado no formato "codCliente - NOME", união dos clientes
// de todos os vendedores dele (buscada via /Roteiro/vendedor/{cod}/clientes).
// null = sem carteira → filtro cai no top_clientes do cubo.
// Clientes da carteira restritos ao(s) vendedor(es) selecionado(s) em ST.vend.
// Casa o nome canônico do cubo (ST.vend) com o codVendedor da carteira.
function clientesDoVendedorSelecionado(){
  const cbv = authSession && authSession.clientesByVend;
  const vc  = authSession && authSession.vendedoresCarteira;
  if (!ST.vend.length || !cbv || !Array.isArray(vc) || !vc.length) return null;
  const idx = buildCanonIndex();
  const nomeToCod = {};
  vc.forEach(v => {
    const canon = resolveVend(idx, { codven: v.cod, nome: v.nome });
    if (canon) nomeToCod[canon] = String(v.cod);
  });
  const cods = ST.vend.map(n => nomeToCod[n]).filter(Boolean);
  if (!cods.length) return null;
  const out = [];
  cods.forEach(cod => (cbv[cod] || []).forEach(c => out.push(c)));
  return out.length ? out : null;
}

function authClienteNames(){
  if (!authSession || !Array.isArray(authSession.clientes) || !authSession.clientes.length) return null;
  // Ordena por NOME (a busca do dropdown já encontra por código, pois o código
  // faz parte do rótulo).
  const itens = (clientesDoVendedorSelecionado() || authSession.clientes)
    .filter(c => c && c.codCliente != null)
    .map(c => ({ cod: c.codCliente, nome: String(c.cliente || c.nomeFantasia || '').trim() }))
    // Sem nome na API (raro) vai p/ o fim da lista, rotulado pelo código.
    .sort((a,b) => (!a.nome) - (!b.nome) || a.nome.localeCompare(b.nome,'pt-BR') || String(a.cod).localeCompare(String(b.cod)));
  return [...new Set(itens.map(c => `${c.cod} - ${c.nome || '(sem nome)'}`))];
}

// Listas de Top clientes/produtos/vendedores da fonte certa. Com recorte carregado,
// d.top_* já vem do banco filtrado por hierarquia + MÊS + demais filtros; os cubos
// hier_top_* são do PERÍODO (semestre) e ignoram o mês — era por isso que a aba Cash
// Margem mostrava, para julho, julho + os dias de agosto (produto 54: 1.379.118 na
// tela contra 1.297.049 no banco).
function topClientesFonte(d, level, names){
  if (d._recorte) return d.top_clientes || [];
  return level ? hierUnionTop(d.hier_top_clientes, level, names) : (d.top_clientes || []);
}
function topProdutosFonte(d, level, names){
  if (d._recorte) return d.top_produtos || [];
  return level ? hierUnionTop(d.hier_top_produtos, level, names) : (d.top_produtos || []);
}

function effectiveGerentes(d){
  if (ST.ger.length) return new Set(ST.ger);
  if (ST.sup.length) return new Set(ST.sup.map(s=>gerenteDoSupervisor(d,s)).filter(Boolean));
  if (ST.vend.length) return new Set(ST.vend.map(v=>gerenteDoVendedor(d,v)).filter(Boolean));
  return null; // sem restrição
}
function effectiveSupervisores(d){
  if (ST.sup.length) return new Set(ST.sup);
  if (ST.vend.length) return new Set(ST.vend.map(v=>supervisorDoVendedor(d,v)).filter(Boolean));
  return null;
}
// Linhas "por Gerente" já restritas aos pais reais de Supervisor/Vendedor
// selecionado (cascata) — usado por Margem/Cash Margem.
function gerenteCascadeRows(d){
  const eff = effectiveGerentes(d);
  return Object.entries(d.por_gerente).filter(([n])=>!eff||eff.has(n));
}
// Linhas "por Categoria" corretas sob filtro de Gerente/Supervisor/Vendedor
// (cubo hier_por_categoria, dado exato) + filtro de Categoria (ST.cat).
function categoriaCascadeRows(d){
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  // Com recorte carregado, d.por_categoria JÁ vem do banco filtrado por hierarquia +
  // mês + demais filtros — é a fonte mais fiel. hier_por_categoria é do cubo do
  // SEMESTRE e ignora mês/canal/status, o que fazia a tabela divergir do banco
  // (de 0,02% a 1,6% para baixo).
  const base = d._recorte ? d.por_categoria
             : (level ? hierUnionCategoria(d, level, names) : d.por_categoria);
  return { level, names, rows: Object.entries(base).filter(([n])=>ST.cat.length===0||ST.cat.includes(n)) };
}
function categoriaValueFor(period, level, names, catName){
  if (!period) return null;
  // Período anterior também recortado → usa o por_categoria dele (mesmo mês, mesmo escopo).
  const base = period._recorte ? period.por_categoria
             : (level ? hierUnionCategoria(period, level, names) : period.por_categoria);
  return base[catName] || null;
}
// Versões "com filtro de Mês" de gerenteCascadeRows/categoriaCascadeRows/
// categoriaValueFor — usadas pelas tabelas "por Gerente"/"por Categoria" de
// Margem, Cash Margem e Meta x Realizado quando ST.mes está ativo. Caem para a
// versão semestral (com aviso) quando o nível ativo é Supervisor/Vendedor
// (sem dado mensal nesse grão — só existe hier_por_dia_categoria.gerente).
function gerenteCascadeRowsFor(d, mes){
  if (mes==null) return { rows: gerenteCascadeRows(d), monthNote:null };
  const eff = effectiveGerentes(d);
  const names = Object.keys(d.por_gerente).filter(n=>!eff||eff.has(n));
  const rows = names.map(n=>{
    const a = monthlyGerenteAgg(d, n, mes);
    return [n, {r:a.r, c:a.c, m: a.r>0?+(100*(1-a.c/a.r)).toFixed(2):0}];
  });
  return { rows, monthNote:null };
}
function gerenteMonthValueFor(period, name, mes){
  if (!period) return null;
  const a = monthlyGerenteAgg(period, name, mes);
  if (a.r===0 && a.c===0) return null;
  return {r:a.r, c:a.c, m: a.r>0?+(100*(1-a.c/a.r)).toFixed(2):0};
}
function categoriaCascadeRowsFor(d, mes){
  // O recorte já vem do banco filtrado pelo mês (e por tudo mais), então não há
  // fallback nem aviso: d.por_categoria é o dado exato do mês.
  if (d._recorte) return { ...categoriaCascadeRows(d), monthNote:null };
  if (mes==null) return { ...categoriaCascadeRows(d), monthNote:null };
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  if (level==='supervisor' || level==='vendedor'){
    return { ...categoriaCascadeRows(d), monthNote:`Filtro de Mês ignorado para ${level} — sem dado mensal neste recorte; mostrando o semestre inteiro.` };
  }
  const base = level==='gerente' ? monthlyGerenteUnionCategoriaAgg(d, names, mes) : monthlyCategoriaAgg(d, mes);
  const rows = Object.entries(base).map(([cat,v])=>[cat,{r:v.r,c:v.c,m:v.r>0?+(100*(1-v.c/v.r)).toFixed(2):0}]).filter(([n])=>ST.cat.length===0||ST.cat.includes(n));
  return { level, names, rows, monthNote:null };
}
// Receita por mês já recortada pelos filtros ativos, usando o grão mais fino que
// existe para cada combinação:
//   Cliente          → por_mes vindo da API (/clientes), exato
//   Gerente [+Cat]   → hier_por_dia_categoria.gerente
//   Categoria        → por_dia_categoria (nível empresa)
//   Supervisor/Vend. → sem grão mensal no cubo: cai p/ empresa, com aviso
function receitaPorMesDoRecorte(d){
  const meses = Object.keys(d.por_mes).sort((a,b)=>+a-+b);
  const geral = () => meses.map(m=>d.por_mes[m].r);

  if (precisaRecorte()){
    const sc = cliScopeAtual();
    if (sc) return { meses, vals: meses.map(m => (sc.por_mes[String(m)] ? sc.por_mes[String(m)].r : 0)),
                     note: `Recorte: ${recorteLabel()}` };
    return { meses, vals: geral(), note: 'Carregando recorte…' };
  }

  const level = hierLevelActive();
  const somaCats = agg => { let r=0; ST.cat.forEach(cat=>{ if (agg[cat]) r += agg[cat].r; }); return r; };

  if (level === 'gerente'){
    if (ST.cat.length) return { meses, vals: meses.map(m=>somaCats(monthlyGerenteUnionCategoriaAgg(d, ST.ger, +m))),
                                note: `Recorte: Gerente + Categoria` };
    return { meses, vals: meses.map(m=>monthlyGerenteUnionAgg(d, ST.ger, +m).r), note: `Recorte: Gerente: ${labelJoin(ST.ger)}` };
  }
  if (level){
    return { meses, vals: geral(),
             note: `Sem grão mensal por ${level} neste cubo — gráfico no nível empresa (os KPIs acima já estão recortados).` };
  }
  if (ST.cat.length){
    return { meses, vals: meses.map(m=>somaCats(monthlyCategoriaAgg(d, +m))), note: `Recorte: Categoria: ${labelJoin(ST.cat)}` };
  }
  return { meses, vals: geral(), note: null };
}

function categoriaMonthValueFor(period, level, names, catName, mes){
  if (!period) return null;
  // Recorte do período anterior já é do mesmo mês — vale para qualquer nível.
  if (period._recorte) return (period.por_categoria || {})[catName] || null;
  if (level==='supervisor'||level==='vendedor') return null;
  const base = level==='gerente' ? monthlyGerenteUnionCategoriaAgg(period, names, mes) : monthlyCategoriaAgg(period, mes);
  const v = base[catName];
  if (!v) return null;
  return {r:v.r,c:v.c,m: v.r>0?+(100*(1-v.c/v.r)).toFixed(2):0};
}
// Meta por categoria recortada por hierarquia (Gerente/Supervisor/Vendedor) E por
// mês — usa d.meta.hier_por_mes_categoria[level][mes][nome][cat]={meta,metaCash}
// (metacategoria cruzada com mês+hierarquia+categoria simultaneamente, ver
// DashboardETLService — antes só existia meta por mês+hierarquia OU por
// mês+categoria, nunca as 3 juntas, então a tabela por Categoria da aba
// Acompanhamento Objetivos não tinha como respeitar um filtro de Gerente/
// Supervisor/Vendedor). Soma sobre a lista de meses recebida (1 mês, bimestre,
// semestre...) — ao contrário do Realizado, a Meta tem grão mensal nos 3 níveis.
function metaCategoriaHierMesFor(d, level, names, meses){
  const merged = {};
  meses.forEach(mes=>{
    const src = d.meta.hier_por_mes_categoria && d.meta.hier_por_mes_categoria[level] && d.meta.hier_por_mes_categoria[level][String(mes)];
    if (!src) return;
    names.forEach(n=>{
      const cats = src[n]; if (!cats) return;
      Object.keys(cats).forEach(cat=>{
        const cur = merged[cat] || (merged[cat]={meta:0,metaCash:0});
        cur.meta += cats[cat].meta; cur.metaCash += cats[cat].metaCash;
      });
    });
  });
  return merged;
}
function hierUnionAbcd(level, names){
  const q = {A:{count:0,receita:0,custo:0},B:{count:0,receita:0,custo:0},C:{count:0,receita:0,custo:0},D:{count:0,receita:0,custo:0}};
  names.forEach(n=>{
    const a = curPeriod().hier_abcd[level][n];
    if (!a) return;
    ['A','B','C','D'].forEach(k=>{ q[k].count+=a[k].count; q[k].receita+=a[k].receita; q[k].custo+=(a[k].custo||0); });
  });
  ['A','B','C','D'].forEach(k=>{ q[k].cash_margin = q[k].receita - q[k].custo; });
  return q;
}
function prevLookupList(prev, listName, nameKey, val){
  if (!prev) return null;
  const x = prev[listName].find(o=>o[nameKey]===val);
  return x ? x.r : null;
}
// Igual a prevLookupList, mas devolve a margem (.m) em vez da receita (.r) — usado
// para o comparativo de margem ano x ano nas tabelas de Rankings/ABCD.
function prevLookupListMargin(prev, listName, nameKey, val){
  if (!prev) return null;
  const x = prev[listName].find(o=>o[nameKey]===val);
  return x ? x.m : null;
}
const escAttr = s => String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
const charts = {};
function mkChart(id,cfg){ if(charts[id]){charts[id].destroy();delete charts[id];} const el=document.getElementById(id); if(!el) return; charts[id]=new Chart(el,cfg); }

// período "anterior" para comparação (mesmo semestre, ano anterior)
const PREV_OF = { "2026_2":"2025_2", "2026_1":"2025_1", "2025_2":"2024_2", "2025_1":null };
const PERIOD_ORDER = ["2026_2","2026_1","2025_2","2025_1"]; // mais recente primeiro

// Abre no semestre do mês corrente (julho/2026 → "2026_2"), caindo no mais recente
// disponível se o ETL ainda não tiver aquele período.
function periodoDoMesAtual(){
  const hoje = new Date();
  return `${hoje.getFullYear()}_${hoje.getMonth() < 6 ? 1 : 2}`;
}
function periodoInicial(){
  const alvo = periodoDoMesAtual();
  if (window.REAL_DATA && REAL_DATA[alvo]) return alvo;
  const disponivel = PERIOD_ORDER.find(k => window.REAL_DATA && REAL_DATA[k]);
  return disponivel || alvo;
}

let ST = { per:periodoDoMesAtual(), mes:null, ger:[], sup:[], vend:[], cat:[], grp:[], cli:[], canal:[], inadimplente:[], status:[] };

function curPeriodRaw(){ return REAL_DATA[ST.per]; }
// TODAS as abas leem o período por aqui. Quando existe recorte carregado (consulta
// ao banco com os filtros ativos, inclusive a trava de acesso do usuário logado), os
// agregados do cubo são SUBSTITUÍDOS pelos do recorte — assim nenhuma aba mostra
// número de fora do escopo de quem está logado. Sem recorte, devolve o cubo puro.
let _mescladoKey = null, _mescladoObj = null;
function curPeriod(){
  const p = curPeriodRaw();
  if (!p) return p;
  const rec = (typeof recorteDados === 'function') ? recorteDados() : null;
  if (!rec){
    // SEGURANÇA: com filtro ativo (inclui a trava do usuário logado) e o recorte
    // ainda em vôo, devolver o cubo aqui exporia a empresa inteira em todas as abas
    // — era exatamente o que acontecia com supervisor, cuja consulta é mais lenta
    // que a do gerente (que já vinha do cache). Enquanto não chega, tudo zerado.
    if (activeFilterCount() > 0) return mesclarRecorte(p, recorteVazio());
    return p;
  }
  const key = ST.per + '|' + cliScopeKey();
  if (_mescladoKey === key && _mescladoObj) return _mescladoObj;
  _mescladoObj = mesclarRecorte(p, rec);
  _mescladoKey = key;
  return _mescladoObj;
}
// Recorte "sem nada" nas mesmas formas do real — usado enquanto a consulta não volta.
function recorteVazio(){
  const abcdZero = {};
  ['A','B','C','D'].forEach(k=>{ abcdZero[k] = { count:0, receita:0, custo:0, cash_margin:0, exemplos:[] }; });
  Object.assign(abcdZero, { mediana_receita:0, mediana_margem:0, n_clientes_considerados:0 });
  return {
    r:0, c:0, q:0, p:0, m:0, cash_margem:0, pedidos:0, linhas:0,
    n_clientes:0, n_vendedores:0, ticket_pedido:0,
    por_mes:{}, por_categoria:{}, por_grupo:{}, por_gerente:{}, por_supervisor:{},
    full_vendedores:{}, por_dia:{}, por_dia_categoria:{}, por_mes_clientes:{},
    por_mes_fumokg:{}, realizado_fumokg:{ por_gerente:{}, por_supervisor:{}, por_vendedor:{} },
    clientes:[], top_produtos:[], vendedores:[],
    top_clientes_cash:[], top_produtos_cash:[], top_vendedores_cash:[],
    pagamento_por_categoria:{}, janela90:{ inicio:null, fim:null }, por_produto_janela90:{},
    qualidade:{ linhas_sem_cliente:0, linhas_sem_produto:0, linhas_sem_vendedor:0,
                linhas_receita_zero_ou_negativa:0, linhas_qtde_zero_ou_negativa:0,
                linhas_custo_maior_que_receita:0 },
    abcd: abcdZero, cascata:{}, _carregando:true
  };
}
// Substitui no período do cubo só o que o recorte cobre. Campos que o recorte não
// tem (meta, hier_*, _estoque…) continuam vindo do cubo — as visões que os usam
// aplicam a trava por conta própria (ex.: meta soma pelos nomes de ST).
function mesclarRecorte(p, rec){
  const o = Object.assign({}, p, {
    receita: rec.r, custo: rec.c, qtde: rec.q, peso: rec.p,
    linhas: rec.linhas, n_pedidos: rec.pedidos, ticket_pedido: rec.ticket_pedido,
    n_cli: rec.n_clientes, n_vend: rec.n_vendedores,
    margem_geral: rec.m,
    por_mes: rec.por_mes,
    por_categoria: rec.por_categoria,
    por_grupo: rec.por_grupo,
    por_gerente: rec.por_gerente,
    por_supervisor: rec.por_supervisor,
    full_vendedores: rec.full_vendedores,
    por_dia: rec.por_dia,
    por_dia_categoria: rec.por_dia_categoria,
    por_mes_clientes: rec.por_mes_clientes,
    // FUMO KG: sem isso a aba Meta comparava meta do escopo com realizado da empresa.
    por_mes_fumokg: rec.por_mes_fumokg,
    realizado_fumokg: rec.realizado_fumokg,
    top_clientes: rec.clientes,
    top_produtos: rec.top_produtos,
    top_vendedores: rec.vendedores,
    top_clientes_cash: rec.top_clientes_cash,
    top_produtos_cash: rec.top_produtos_cash,
    top_vendedores_cash: rec.top_vendedores_cash,
    pagamento_por_categoria: rec.pagamento_por_categoria,
    janela90: rec.janela90,
    por_produto_janela90: rec.por_produto_janela90,
    qualidade: rec.qualidade,
    abcd: rec.abcd,
    cascata: rec.cascata,
    _recorte: true,
    _carregando: !!rec._carregando   // recorte vazio (consulta em vôo) → avisa na tela
  });
  // n_sup/n_ger/n_prod/n_cat/n_grp derivados do próprio recorte.
  o.n_sup = Object.keys(rec.por_supervisor || {}).length;
  o.n_ger = Object.keys(rec.por_gerente || {}).length;
  o.n_cat = Object.keys(rec.por_categoria || {}).length;
  o.n_grp = Object.keys(rec.por_grupo || {}).length;
  return o;
}
function labelJoin(arr){ return arr.length<=2 ? arr.join(" + ") : arr.length+" selecionados"; }
function activeFilterCount(){ return ["ger","sup","vend","cat","grp","cli","canal","inadimplente","status"].filter(k=>ST[k].length>0).length; }

// ── ESCOPO ATIVO (soma real dentro de UMA dimensão) ─────────────
function sumDict(dict, keys){
  let r=0,c=0,q=0,qOk=true;
  const src = dict || {};   // agregado ausente no cubo (ex.: cache antigo) não quebra a tela
  keys.forEach(k=>{ const x=src[k]; if(x){ r+=x.r; c+=x.c; if(x.q!=null) q+=x.q; else qOk=false; } });
  return {r,c,q:qOk?q:null};
}
function sumList(list, keys, nameKey){
  let r=0,c=0,q=0;
  list.filter(x=>keys.includes(x[nameKey])).forEach(x=>{ r+=x.r; c+=x.c; q+=x.q; });
  return {r,c,q};
}
// ── RECORTE POR CLIENTE (sob demanda na API) ──────────────────────────────
// O cubo só tem o Top-50 de clientes, então cliente da carteira ficaria zerado.
// A API expõe /clientes?periodo=&cods= (mesma query do ETL, filtrada por código),
// e o resultado é cacheado aqui por (período + códigos).
let CLI_SCOPE = null;          // { key, dados } — recorte do período atual
let cliScopePending = null;    // key em vôo
let PREV_SCOPE = null;         // { key, dados } — mesmo recorte no período anterior
let prevScopePending = null;
let cliScopeFetch = null;      // promise da consulta em vôo (o boot aguarda por ela)
let recorteErro = null;        // última falha, p/ avisar na tela em vez de zerar calado

// Códigos dos clientes selecionados. Rótulo da carteira é "12345 - NOME"; itens
// do cubo (top 50) vêm só como nome, então caímos no código do próprio cubo.
function cliCodesFromST(){
  const d = (window.REAL_DATA && REAL_DATA[ST.per]) || null;
  const porNome = {};
  if (d && Array.isArray(d.top_clientes)) d.top_clientes.forEach(c=>{ porNome[c.nome] = c.codigo; });
  const out = [];
  ST.cli.forEach(label=>{
    const m = /^(\d+)\s*-\s*/.exec(label);
    if (m) out.push(m[1]);
    else if (porNome[label] != null) out.push(String(porNome[label]));
  });
  return [...new Set(out)];
}
// Filtros que o cubo pré-agregado NÃO cruza — nesses casos o número certo só sai
// consultando o banco (/recorte, mesma query do ETL com WHERE dinâmico):
//   • Canal de Vendas / Inadimplente / Status do cliente (não existem cruzados);
//   • Cliente (cubo só tem o Top-50 do período);
//   • Grupo combinado com hierarquia (não há hier_por_grupo).
// Hierarquia sozinha e Categoria (+hierarquia) continuam vindo do cubo: é exato e
// instantâneo.
function precisaRecorte(){
  if (ST.canal.length || ST.inadimplente.length || ST.status.length) return true;
  if (ST.cli.length) return true;
  if (ST.grp.length && hierLevelActive()) return true;
  return false;
}
function recorteQuery(){
  const p = new URLSearchParams();
  p.set('periodo', ST.per);
  const add = (k, arr) => { if (arr && arr.length) p.set(k, arr.join('|')); };
  add('cli', cliCodesFromST());
  add('ger', ST.ger); add('sup', ST.sup); add('vend', ST.vend);
  add('cat', ST.cat); add('grp', ST.grp);
  add('canal', ST.canal); add('inad', ST.inadimplente); add('status', ST.status);
  // O painel é mensal: o recorte já vem filtrado pelo mês, então TODAS as abas
  // (inclusive as que não tinham grão mensal no cubo) passam a refletir o mês.
  if (ST.mes != null) p.set('mes', String(ST.mes));
  return p.toString();
}
function cliScopeKey(){ return recorteQuery(); }
// Recorte já carregado que corresponde EXATAMENTE aos filtros atuais (ou null).
// Serve para qualquer visão que o cubo não consegue recortar — ex.: "Top Grupos de
// Produto", que não tem cruzamento com hierarquia (hier_por_grupo não existe) e por
// isso mostrava o total da empresa mesmo com um gerente selecionado.
function recorteDados(){
  return (CLI_SCOPE && CLI_SCOPE.key === cliScopeKey()) ? CLI_SCOPE.dados : null;
}
// Versão para os KPIs: só assume o comando quando o cubo NÃO resolve a combinação,
// senão os números continuam vindo do cubo (instantâneo).
function cliScopeAtual(){
  if (!precisaRecorte()) return null;
  return recorteDados();
}
// Dispara a busca se necessário; ao chegar, re-renderiza (idempotente: na segunda
// passada a key já casa e nada é refeito). Busca com QUALQUER filtro ativo — os KPIs
// seguem vindo do cubo quando ele é exato, mas as visões sem cruzamento no cubo
// (grupos/produtos) passam a refletir o recorte.
// Devolve uma Promise que resolve quando o recorte do período ATUAL está disponível
// (o boot espera por ela antes de renderizar; re-renders só disparam e seguem).
function ensureCliScope(){
  if (activeFilterCount() === 0){
    CLI_SCOPE = null; cliScopePending = null; PREV_SCOPE = null; prevScopePending = null;
    return Promise.resolve();
  }
  const key = cliScopeKey();
  let p = Promise.resolve();
  if (CLI_SCOPE && CLI_SCOPE.key === key){
    // já carregado
  } else if (cliScopePending === key && cliScopeFetch){
    p = cliScopeFetch;
  } else {
    cliScopePending = key;
    cliScopeFetch = fetch(`${API_BASE_URL}/recorte?${key}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => {
        if (j && j.error) throw new Error(j.error);
        CLI_SCOPE = { key, dados: j };
        recorteErro = null;
        if (cliScopePending === key){ cliScopePending = null; renderAll(); }
      })
      .catch(e => {
        console.warn('[recorte] falha ao consultar:', e.message);
        recorteErro = e.message;
        if (cliScopePending === key) cliScopePending = null;
        renderAll();
      });
    p = cliScopeFetch;
  }
  ensurePrevScope();
  return p;
}
// Mesmo recorte no período anterior — sem isso os deltas "vs ano anterior"
// comparariam o escopo do usuário contra a empresa inteira.
function prevScopeKey(){
  const prevKey = PREV_OF[ST.per];
  if (!prevKey) return null;
  return cliScopeKey().replace(`periodo=${encodeURIComponent(ST.per)}`, `periodo=${encodeURIComponent(prevKey)}`);
}
function prevScopeDados(){
  const k = prevScopeKey();
  return (k && PREV_SCOPE && PREV_SCOPE.key === k) ? PREV_SCOPE.dados : null;
}
function ensurePrevScope(){
  const key = prevScopeKey();
  if (!key){ PREV_SCOPE = null; prevScopePending = null; return; }
  if ((PREV_SCOPE && PREV_SCOPE.key === key) || prevScopePending === key) return;
  prevScopePending = key;
  fetch(`${API_BASE_URL}/recorte?${key}`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(j => {
      if (j && j.error) throw new Error(j.error);
      PREV_SCOPE = { key, dados: j };
      if (prevScopePending === key){ prevScopePending = null; renderAll(); }
    })
    .catch(e => { console.warn('[recorte prev] falha:', e.message); if (prevScopePending === key) prevScopePending = null; });
}
// Período anterior já recortado (ou o cubo puro, se não houver recorte).
let _mescladoPrevKey = null, _mescladoPrevObj = null;
function prevPeriod(){
  const prevKey = PREV_OF[ST.per];
  const p = prevKey ? REAL_DATA[prevKey] : null;
  const rec = prevScopeDados();
  if (!p) return null;
  // Mesma proteção do curPeriod: sem o recorte do período anterior, comparar contra
  // a empresa inteira produziria deltas errados (e expostos).
  if (!rec) return activeFilterCount() > 0 ? mesclarRecorte(p, recorteVazio()) : p;
  const key = prevKey + '|' + prevScopeKey();
  if (_mescladoPrevKey === key && _mescladoPrevObj) return _mescladoPrevObj;
  _mescladoPrevObj = mesclarRecorte(p, rec);
  _mescladoPrevKey = key;
  return _mescladoPrevObj;
}
// Rótulo do recorte ativo, do filtro mais específico para o mais amplo.
function recorteLabel(){
  const partes = [];
  if (ST.cli.length) partes.push("Cliente: "+labelJoin(ST.cli));
  if (ST.vend.length) partes.push("Vendedor: "+labelJoin(ST.vend));
  if (ST.sup.length) partes.push("Supervisor: "+labelJoin(ST.sup));
  if (ST.ger.length) partes.push("Gerente: "+labelJoin(ST.ger));
  if (ST.grp.length) partes.push("Grupo: "+labelJoin(ST.grp));
  if (ST.cat.length) partes.push("Categoria: "+labelJoin(ST.cat));
  if (ST.canal.length) partes.push("Canal: "+labelJoin(ST.canal));
  if (ST.inadimplente.length) partes.push("Inadimplente: "+labelJoin(ST.inadimplente));
  if (ST.status.length) partes.push("Status: "+labelJoin(ST.status));
  return partes.join(" · ");
}
// Clientes do recorte no formato das listas do cubo (p/ tabelas e rankings).
function cliScopeClientes(){
  const sc = cliScopeAtual();
  return sc && Array.isArray(sc.clientes) ? sc.clientes : null;
}
// Aplica o filtro de Cliente numa lista do cubo. Com cliente selecionado, prefere
// as linhas reais vindas da API (cobrem qualquer cliente, não só o Top-50).
function filtrarClientes(lista){
  // Com recorte carregado, as linhas vêm do banco e já refletem TODOS os filtros
  // (inclui Canal/Inadimplente/Status, que o cubo não cruza).
  const rec = cliScopeClientes();
  if (rec) return rec;
  if (!ST.cli.length) return lista;
  return lista.filter(c => ST.cli.includes(c.nome));
}

// Precedência: Cliente > Vendedor > Grupo > Categoria > Supervisor > Gerente.
function lookupScope(d){
  if (!d) return null;
  // Combinação que o cubo não cruza → números exatos vindos de /recorte. Cobre
  // TODOS os filtros ao mesmo tempo (inclui Canal/Inadimplente/Status), então não
  // há precedência a aplicar aqui.
  if (precisaRecorte()){
    const sc = cliScopeAtual();
    const label = recorteLabel();
    if (sc) return { r:sc.r, c:sc.c, q:sc.q, label };
    // Enquanto a consulta não volta, NÃO aproximar pelo cubo: o agregado da empresa
    // (ex.: Canal sem o recorte do gerente) mostraria um número muito maior que o
    // certo e piscaria na tela. Fica zerado com aviso até chegar o valor real.
    return { r:0, c:0, q:null, label, carregando:true };
  }
  if (ST.vend.length){ return {...sumDict(d.full_vendedores, ST.vend), label:"Vendedor: "+labelJoin(ST.vend)}; }
  if (ST.grp.length){ return {...sumDict(d.por_grupo, ST.grp), label:"Grupo: "+labelJoin(ST.grp)}; }
  if (ST.cat.length){
    // Categoria + Gerente/Supervisor/Vendedor tem dado EXATO no cubo hierárquico
    // (hier_por_categoria) — sem ele o recorte cairia no total da empresa naquela
    // categoria. Usa o nível mais específico selecionado.
    const level = hierLevelActive();
    if (level){
      const names = hierSelectedNames(level);
      const catAgg = hierUnionCategoria(d, level, names);
      let r=0,c=0,q=0,qOk=true;
      ST.cat.forEach(cat=>{ const x=catAgg[cat]; if(x){ r+=x.r; c+=x.c; if(x.q!=null) q+=x.q; else qOk=false; } });
      return { r, c, q: qOk?q:null,
        label:"Categoria: "+labelJoin(ST.cat)+" · "+level[0].toUpperCase()+level.slice(1)+": "+labelJoin(names) };
    }
    return {...sumDict(d.por_categoria, ST.cat), label:"Categoria: "+labelJoin(ST.cat)};
  }
  if (ST.sup.length){ return {...sumDict(d.por_supervisor, ST.sup), label:"Supervisor: "+labelJoin(ST.sup)}; }
  if (ST.ger.length){ return {...sumDict(d.por_gerente, ST.ger), label:"Gerente: "+labelJoin(ST.ger)}; }
  return null;
}

// ── FILTRO GLOBAL DE MÊS (barra lateral) ──────────────────────────
// Só existe dado diário (por_dia/por_dia_categoria) no nível empresa e, por
// Gerente, no cubo hier_por_dia_categoria.gerente (ver Sazonalidade/Motivos) —
// por isso o filtro de Mês só é exato para: empresa toda, Categoria, Gerente, e
// Gerente+Categoria juntos. Supervisor/Vendedor/Grupo/Cliente não têm esse grão;
// nesses casos o filtro de Mês é ignorado (com aviso) e mostra o semestre inteiro.
function monthlyGerenteCategoriaAgg(period, gerName, mes){
  const out = {};
  const dict = period && period.hier_por_dia_categoria && period.hier_por_dia_categoria.gerente && period.hier_por_dia_categoria.gerente[gerName];
  if (!dict) return out;
  const mesStr = String(mes).padStart(2,'0');
  Object.keys(dict).forEach(dateKey=>{
    if (dateKey.slice(5,7)!==mesStr) return;
    const catMap = dict[dateKey];
    Object.keys(catMap).forEach(cat=>{
      if (!out[cat]) out[cat] = {r:0,c:0};
      out[cat].r += catMap[cat][0]||0; out[cat].c += catMap[cat][1]||0;
    });
  });
  return out;
}
function monthlyGerenteUnionCategoriaAgg(period, gerNames, mes){
  const merged = {};
  gerNames.forEach(n=>{
    const catBreak = monthlyGerenteCategoriaAgg(period, n, mes);
    Object.keys(catBreak).forEach(cat=>{
      if (!merged[cat]) merged[cat] = {r:0,c:0};
      merged[cat].r += catBreak[cat].r; merged[cat].c += catBreak[cat].c;
    });
  });
  return merged;
}
function monthlyGerenteUnionAgg(period, gerNames, mes){
  const catBreak = monthlyGerenteUnionCategoriaAgg(period, gerNames, mes);
  let r=0,c=0; Object.values(catBreak).forEach(v=>{ r+=v.r; c+=v.c; });
  return {r,c};
}
function monthlyGerenteAgg(period, gerName, mes){
  return monthlyGerenteUnionAgg(period, [gerName], mes);
}
// Mesma precedência de lookupScope, mas com dado mensal. Retorna {fallback:true,
// label} quando a dimensão ativa não tem grão mensal disponível.
function monthScopedScope(d, mes){
  // Com recorte, o período JÁ vem do banco filtrado pelo mês — então o escopo do mês
  // é o próprio lookupScope. Antes caía no cubo diário (hier_por_dia), que só tem
  // receita e custo: a "Qtde vendida" ficava "—" por falta de quantidade nesse grão.
  if (d && d._recorte){
    const s = lookupScope(d);
    if (s) return { r:s.r, c:s.c, q:s.q, label:s.label };
    return { r:d.receita, c:d.custo, q:d.qtde, label:null };
  }
  if (precisaRecorte()){
    // /recorte já devolve por_mes do recorte inteiro — filtro de Mês fica exato
    // até para Canal/Inadimplente/Status, que o cubo não tem por mês.
    const sc = cliScopeAtual();
    const label = recorteLabel();
    if (sc){
      const m = sc.por_mes && sc.por_mes[String(mes)];
      return m ? { r:m.r, c:m.c, q:m.q, label } : { r:0, c:0, q:0, label };
    }
    return { fallback:true, label };
  }
  if (ST.vend.length) return { fallback:true, label:"Vendedor: "+labelJoin(ST.vend) };
  if (ST.grp.length) return { fallback:true, label:"Grupo: "+labelJoin(ST.grp) };
  if (ST.cat.length){
    if (ST.sup.length) return { fallback:true, label:"Categoria: "+labelJoin(ST.cat)+" (recorte de Supervisor)" };
    if (ST.ger.length){
      const catBreak = monthlyGerenteUnionCategoriaAgg(d, ST.ger, mes);
      let r=0,c=0; ST.cat.forEach(cat=>{ const v=catBreak[cat]; if(v){r+=v.r;c+=v.c;} });
      return {r,c,q:null,label:"Categoria: "+labelJoin(ST.cat)+" · Gerente: "+labelJoin(ST.ger)};
    }
    const catAgg = monthlyCategoriaAgg(d, mes);
    let r=0,c=0; ST.cat.forEach(cat=>{ const v=catAgg[cat]; if(v){r+=v.r;c+=v.c;} });
    return {r,c,q:null,label:"Categoria: "+labelJoin(ST.cat)};
  }
  if (ST.sup.length) return { fallback:true, label:"Supervisor: "+labelJoin(ST.sup) };
  if (ST.ger.length){
    const a = monthlyGerenteUnionAgg(d, ST.ger, mes);
    return {r:a.r,c:a.c,q:null,label:"Gerente: "+labelJoin(ST.ger)};
  }
  const g = monthlyGeralAgg(d, mes);
  return {r:g.r,c:g.c,q:null,label:null};
}
// Combina lookupScope (dimensão) + filtro de Mês num único objeto sempre válido
// {r,c,q,label,monthNote} — label null = sem nenhum filtro (dimensão OU mês).
function effectiveFor(period, mes){
  if (!period) return null;
  
  // Função auxiliar para evitar vazamento de dados "GERAL"
  function secureFallback(fb) {
    if (authSession && (authSession.role === 'supervisor' || authSession.role === 'gerente') && !fb.label) {
       return {r:0,c:0,q:0,label:"Nenhum dado autorizado na seleção",monthNote:null};
    }
    return fb;
  }

  if (mes==null){
    const s = lookupScope(period);
    return s ? {...s, monthNote:null} : secureFallback({r:period.receita,c:period.custo,q:period.qtde,label:null,monthNote:null});
  }
  const ms = monthScopedScope(period, mes);
  if (ms.fallback){
    const s = lookupScope(period);
    const fb = s || {r:period.receita,c:period.custo,q:period.qtde,label:null};
    // Se o recorte ainda está sendo consultado, o Mês não foi "ignorado" — só não
    // chegou. O aviso de carregando já é mostrado pelo KPI.
    if (fb.carregando) return secureFallback({...fb, monthNote:null});
    return secureFallback({...fb, monthNote:`Filtro de Mês ignorado para ${ms.label} — sem dado mensal neste recorte; mostrando o semestre inteiro para esse filtro.`});
  }
  const label = ms.label ? `${ms.label} · Mês: ${MESES_NOME[mes]}` : `Mês: ${MESES_NOME[mes]}`;
  return {r:ms.r,c:ms.c,q:ms.q,label,monthNote:null};
}

// ── WIDGET DE SELEÇÃO MÚLTIPLA ───────────────────────────────────
let msOpenId = null, msOpenSearch = "", msScrollTop = 0;
function closeAllMs(exceptId){
  document.querySelectorAll(".ms-wrap").forEach(w=>{
    if (w.id===exceptId) return;
    const dd=w.querySelector(".ms-dropdown"), btn=w.querySelector(".ms-btn");
    if (dd) dd.classList.remove("open");
    if (btn) btn.classList.remove("open");
  });
  if (exceptId===undefined) msOpenId = null;
}
document.addEventListener("click", e => { if (!e.target.closest(".ms-wrap")) { closeAllMs(); } });

function buildMultiSelect(elId, options, selectedArr, placeholderAll, onChange){
  const wrap = document.getElementById(elId);
  if (!wrap) return;
  const label = selectedArr.length===0 ? placeholderAll : labelJoin(selectedArr);
  let disabledStr = "";
  if (authSession) {
    if (elId === 'ms-ger' && (authSession.role === 'gerente' || authSession.role === 'supervisor')) disabledStr = "disabled";
    if (elId === 'ms-sup' && authSession.role === 'supervisor') disabledStr = "disabled";
  }

  wrap.innerHTML = `
    <button type="button" class="ms-btn" ${disabledStr}><span class="ms-label">${escAttr(label)}</span>${selectedArr.length?`<span class="ms-count">${selectedArr.length}</span>`:''}<span class="ms-arrow">▾</span></button>
    <div class="ms-dropdown">
      <input class="ms-search" placeholder="🔍 Buscar...">
      <div class="ms-list"></div>
      <button type="button" class="ms-clear">↺ Limpar seleção (${placeholderAll})</button>
    </div>`;
  const btn = wrap.querySelector(".ms-btn");
  const dd = wrap.querySelector(".ms-dropdown");
  const search = wrap.querySelector(".ms-search");
  const list = wrap.querySelector(".ms-list");

  function renderList(filterText){
    const ft = (filterText||"").toLowerCase();
    const filtered = options.filter(o=>o.toLowerCase().includes(ft));
    list.innerHTML = filtered.map(o=>`<div class="ms-opt${selectedArr.includes(o)?' selected':''}" data-val="${escAttr(o)}"><input type="checkbox" ${selectedArr.includes(o)?'checked':''}><span>${escAttr(o)}</span></div>`).join("") || `<div class="ms-opt" style="cursor:default">Nenhuma opção</div>`;
  }
  renderList(msOpenId===elId ? msOpenSearch : "");

  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = !dd.classList.contains("open");
    closeAllMs(elId);
    dd.classList.toggle("open", willOpen);
    btn.classList.toggle("open", willOpen);
    msOpenId = willOpen ? elId : null;
    if (willOpen) { search.value = msOpenSearch = ""; msScrollTop = 0; renderList(""); search.focus(); }
  };
  search.oninput = () => { msOpenSearch = search.value; msScrollTop = 0; renderList(search.value); };
  list.onclick = (e) => {
    const opt = e.target.closest(".ms-opt"); if (!opt || !opt.dataset.val) return;
    const val = opt.dataset.val;
    const idx = selectedArr.indexOf(val);
    if (idx>=0) selectedArr.splice(idx,1); else selectedArr.push(val);
    // preserva a posição de rolagem para não "pular" ao topo a cada item marcado.
    msScrollTop = list.scrollTop;
    // Defer the DOM rebuild (onChange rebuilds this widget via innerHTML) so the
    // click event finishes bubbling to document first — otherwise the outside-click
    // detector sees a detached target mid-bubble and incorrectly closes the dropdown.
    setTimeout(() => onChange(selectedArr), 0);
  };
  wrap.querySelector(".ms-clear").onclick = () => { selectedArr.length=0; msScrollTop=0; setTimeout(() => onChange(selectedArr), 0); };

  // Reabre no mesmo estado após rebuild: mantém busca, rolagem e foco.
  if (msOpenId===elId){
    dd.classList.add("open"); btn.classList.add("open");
    search.value = msOpenSearch;
    list.scrollTop = msScrollTop;
    const s = search; setTimeout(()=>{ try{ s.focus(); const n=s.value.length; s.setSelectionRange(n,n); }catch(e){} }, 0);
  }
}

// ── CONFIG DE FILTROS + CASCATA ──────────────────────────────────
const FILTERS = {
  ger:  { elId:"ms-ger",  placeholder:"Gerente — todos",              dependents:["sup","vend","cli"],
          getOptions:d=>Object.keys(d.por_gerente).sort() },
  sup:  { elId:"ms-sup",  placeholder:"Supervisor — todos",           dependents:["vend","cli"],
          getOptions:d=>Object.keys(d.por_supervisor).filter(s=>ST.ger.length===0||ST.ger.includes(d.por_supervisor[s].gerente)).sort() },
  vend: { elId:"ms-vend", placeholder:"Vendedor — todos (reais/ativos)", dependents:["cli"],
          getOptions:d=>{
            const list = vendedoresReais(d).filter(v=>{
              if (ST.sup.length && !ST.sup.includes(v.supervisor)) return false;
              if (ST.ger.length){ 
                let ger=null;
                const sup=d.por_supervisor[v.supervisor]; 
                if (sup) ger=sup.gerente;
                else {
                  const h = window.REAL_DATA && REAL_DATA._hierarquia;
                  if (h && Array.isArray(h.gerentes)) {
                    for (const g of h.gerentes) {
                      for (const s of g.supervisores || []) {
                        if (s.nomesupervisor === v.supervisor) { ger = g.nomegerente; break; }
                      }
                      if (ger) break;
                    }
                  }
                }
                if(!ger||!ST.ger.includes(ger)) return false; 
              }
              return true;
            });
            return [...new Set(list.map(v=>v.nome))].sort();
          } },
  cat:  { elId:"ms-cat",  placeholder:"Categoria — todas",            dependents:["grp"],
          getOptions:d=>Object.keys(d.por_categoria).sort() },
  grp:  { elId:"ms-grp",  placeholder:"Grupo — todos",                dependents:[],
          getOptions:d=>Object.keys(d.por_grupo).filter(g=>ST.cat.length===0||ST.cat.includes(d.por_grupo[g].categoria)).sort() },
  cli:  { elId:"ms-cli",  placeholder:"Cliente — carteira",           dependents:[],
          getOptions:d=>{ const carteira = authClienteNames(); return carteira || d.top_clientes.map(c=>c.nome); } },
  canal: { elId:"ms-canal", placeholder:"Canal de Vendas — todos",    dependents:[],
          getOptions:d=>Object.keys(d.por_canal || {}).sort() },
  inadimplente: { elId:"ms-inadimplente", placeholder:"Inadimplente (S/N)", dependents:[],
          getOptions:d=>Object.keys(d.por_inadimplente || {}).sort() },
  status: { elId:"ms-status", placeholder:"Status — todos",           dependents:[],
          getOptions:d=>Object.keys(d.por_status || {}).sort() },
};

function renderFilterWidget(key){
  const d = curPeriod();
  const cfg = FILTERS[key];
  buildMultiSelect(cfg.elId, cfg.getOptions(d), ST[key], cfg.placeholder, (newSel) => {
    ST[key] = newSel;
    renderFilterWidget(key); // refresh own button label/count (preserves open state via msOpenId)
    cfg.dependents.forEach(dep => {
      const valid = new Set(FILTERS[dep].getOptions(d));
      ST[dep] = ST[dep].filter(v=>valid.has(v));
      renderFilterWidget(dep);
    });
    renderAll();
  });
}

function populateFilters(){
  Object.keys(FILTERS).forEach(renderFilterWidget);
  const d = curPeriod();
  document.getElementById("topPeriodo").textContent = d.label;
  document.getElementById("sbFootTxt").textContent = `Base: ${fN(d.linhas)} linhas reais (API) — ${d.label}`;
  populateMesGlobalFilter();
}
// Filtro global de Mês (barra lateral) — reaproveita acompAvailableMonths (mesma
// lista de meses com dado real usada na aba Acompanhamento de Meta).
// O painel opera POR MÊS: o seletor lista todos os meses com venda de todos os
// semestres do cubo ("Jul/2026"), e o período (semestre) é derivado da escolha.
// Antes o padrão era o semestre inteiro, o que comparava 1 mês realizado contra 6
// meses de meta / semestre fechado do ano anterior.
function mesesDisponiveis(){
  const out = [];
  PERIOD_ORDER.forEach(per => {
    const p = REAL_DATA[per];
    if (!p || !p.por_mes) return;
    const ano = per.slice(0, 4);
    Object.keys(p.por_mes).map(Number).sort((a, b) => b - a).forEach(m => {
      out.push({ per, mes: m, label: `${MESES_NOME[m]}/${ano}` });
    });
  });
  return out;   // mais recente primeiro (PERIOD_ORDER já vem assim)
}
function populateMesGlobalFilter(){
  const sel = document.getElementById("fMesGlobal");
  if (!sel) return;
  const opts = mesesDisponiveis();
  sel.innerHTML = opts.map(o=>`<option value="${o.per}|${o.mes}">${o.label}</option>`).join("");
  const atual = `${ST.per}|${ST.mes}`;
  if (opts.some(o=>`${o.per}|${o.mes}`===atual)) sel.value = atual;
  else if (opts.length){ ST.per = opts[0].per; ST.mes = opts[0].mes; sel.value = `${ST.per}|${ST.mes}`; }
  const note = document.getElementById("mesGlobalNote");
  if (note) note.textContent = opts.length ? `Mês de referência de todo o painel (${opts.length} meses com venda)` : "Sem meses com venda";
}
function onMesGlobalChange(){
  const v = document.getElementById("fMesGlobal").value;   // "2026_2|7"
  if (!v) return;
  const [per, mes] = v.split("|");
  const trocouPeriodo = per !== ST.per;
  ST.per = per;
  ST.mes = +mes;
  // Trocar de semestre invalida as listas dependentes (vendedores/clientes do cubo).
  if (trocouPeriodo) resetFiltros(); else renderAll();
}

function resetFiltros(){
  Object.keys(FILTERS).forEach(k=>ST[k]=[]);
  
  // Re-aplicar Trava de Acesso Rígida (nomes resolvidos p/ chaves canônicas do cubo)
  applyAccessLock();

  // ST.mes NÃO é zerado: o painel é mensal e sempre tem um mês de referência.
  msOpenId = null;
  populateFilters();
  renderAll();
}

// ── INIT ──────────────────────────────────────────────────────
function init(){
  const selPer = document.getElementById("fPeriodo");
  // Garante que o período aberto existe no cubo (o padrão é o do mês corrente).
  if (!REAL_DATA[ST.per]) ST.per = periodoInicial();
  // Abre no mês corrente; se ele ainda não tem venda, no mês mais recente que tem.
  const mesesPer = Object.keys((REAL_DATA[ST.per]||{}).por_mes || {}).map(Number);
  if (ST.mes == null || !mesesPer.includes(ST.mes)) {
    const hojeMes = new Date().getMonth() + 1;
    ST.mes = mesesPer.includes(hojeMes) ? hojeMes : (mesesPer.sort((a,b)=>b-a)[0] ?? null);
  }
  selPer.innerHTML = PERIOD_ORDER.filter(k=>REAL_DATA[k]).map(k=>`<option value="${k}">${REAL_DATA[k].label}</option>`).join("");
  selPer.value = ST.per;
  selPer.onchange = () => { ST.per = selPer.value; resetFiltros(); };

  populateFilters();
  renderAll();
}

function showMod(id, el){
  document.querySelectorAll(".mod").forEach(m=>m.classList.remove("on"));
  document.getElementById(id).classList.add("on");
  document.querySelectorAll(".nav-item").forEach(n=>n.classList.remove("on"));
  el.classList.add("on");
  document.getElementById("topSection").textContent = el.querySelector(".nav-txt").textContent;
}

function renderAll(){
  // Cliente selecionado → garante o recorte real vindo da API (re-renderiza ao chegar).
  ensureCliScope();
  renderVisao(); renderComp(); renderMargemCash(); renderObjetivos(); renderMetasExtra(); renderDias(); renderRank(); renderMix(); renderAbcd(); renderPlanos(); renderEstoque(); renderPagamento(); renderRiscoOport(); renderRiscoOportCat(); renderCascata(); renderQual();
}

// O mês selecionado é o mês CORRENTE? Nesse caso o realizado é parcial (só os dias
// já decorridos) e comparar com a meta cheia do mês subestima o atingimento — o
// painel avisa em vez de deixar o número parecer ruim.
function mesParcialInfo(){
  if (ST.mes == null) return null;
  const hoje = new Date();
  const anoPer = parseInt(String(ST.per).slice(0, 4), 10);
  if (hoje.getFullYear() !== anoPer || (hoje.getMonth() + 1) !== ST.mes) return null;
  const diasNoMes = new Date(anoPer, ST.mes, 0).getDate();
  const dia = hoje.getDate();
  return { dia, diasNoMes, pct: dia / diasNoMes, label: `mês em curso — ${dia} de ${diasNoMes} dias (${(dia / diasNoMes * 100).toFixed(0)}% do mês)` };
}

// Meta de rentabilidade (Cash Margem alvo) do escopo ativo. Vem de
// meta.por_mes[mes][nivel][nome] quando há filtro de Mês; senão do total do período.
// Também devolve o % de margem alvo (permargem) para comparar com a margem realizada.
function metaRentabilidade(d, mes){
  const vazio = { valor: 0, permargem: null, nivel: null };
  if (!d || !d.meta) return vazio;
  const mensal = (mes != null && d.meta.por_mes) ? d.meta.por_mes[String(mes)] : null;
  const fonte = nivel => mensal ? (mensal[nivel] || {}) : (d.meta['por_' + nivel] || {});
  const somar = (nivel, nomes) => {
    const dict = fonte(nivel);
    let valor = 0, receita = 0;
    nomes.forEach(n => { const m = dict[n]; if (m){ valor += (m.meta_valrentabilidade || 0); receita += (m.meta_geral || 0); } });
    // Margem alvo PONDERADA (meta de margem ÷ meta de receita). O permargem gravado
    // varia por categoria (9,7% a 34,7%); o máximo não representa o alvo do conjunto.
    return { valor, permargem: receita > 0 ? valor / receita : null, nivel };
  };
  if (ST.vend.length) return somar('vendedor', ST.vend);
  if (ST.sup.length)  return somar('supervisor', ST.sup);
  if (ST.ger.length)  return somar('gerente', ST.ger);
  return somar('gerente', Object.keys(fonte('gerente')));
}

// ── 1. VISÃO GERAL ────────────────────────────────────────────
function renderVisao(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();

  const eff = effectiveFor(d, ST.mes);
  const prevEff = prev ? effectiveFor(prev, ST.mes) : null;
  // Só avisa quando o número REALMENTE é aproximado. É exato quando:
  // • o recorte veio de /recorte (query no banco cruza todos os filtros); ou
  // • hierarquia isolada; ou Categoria + hierarquia (cubo hier_por_categoria).
  const nConflict = (() => {
    if (activeFilterCount() <= 1) return false;
    if (precisaRecorte()) return !cliScopeAtual();          // impreciso só enquanto carrega
    const hierN = (ST.ger.length?1:0) + (ST.sup.length?1:0) + (ST.vend.length?1:0);
    const outrosN = (ST.cat.length?1:0) + (ST.grp.length?1:0);
    if (outrosN === 0) return false;                       // só hierarquia
    if (outrosN === 1 && ST.cat.length && hierN >= 1) return false; // Categoria + hierarquia
    return true;
  })();

  document.getElementById("vg-sub").textContent = eff.label ? `${d.label} · recortado por ${eff.label}` : d.label;
  document.getElementById("vg-meta").textContent = eff.label ? `${fN(d.linhas)} linhas no período (recorte não desagrega linhas)` : `${fN(d.linhas)} linhas · ${fN(d.n_pedidos)} pedidos`;

  const effMargem = eff.r>0 ? +(100*(1-eff.c/eff.r)).toFixed(2) : 0;
  const prevMargem = prevEff ? (prevEff.r>0?100*(1-prevEff.c/prevEff.r):0) : null;

  const cashMargem = eff.r - eff.c;
  const prevCashMargem = prevEff ? (prevEff.r - prevEff.c) : null;
  const vsTxt = ST.mes!=null ? 'vs. mesmo mês ano anterior' : 'vs. mesmo semestre ano anterior';
  const kpis = [
    {lbl:"Receita", val:fM(eff.r), delta: prevEff?fDelta(eff.r,prevEff.r):null, cls:"k0"},
    {lbl:"Margem %", val:fPct(effMargem), delta: prevEff?fDelta(effMargem,prevMargem):null, cls:"k1"},
    {lbl:"Cash Margem (R$)", val:fM(cashMargem), delta: prevEff?fDelta(cashMargem,prevCashMargem):null, cls:"k6"},
    {lbl:"Qtde vendida", val: eff.q!=null?fN(eff.q):"—", delta: (prevEff&&eff.q!=null&&prevEff.q!=null)?fDelta(eff.q,prevEff.q):null, note: eff.q==null?"não recortável para este filtro neste cubo":null, cls:"k2"},
    {lbl:"Ticket médio/pedido", val:fF(d.ticket_pedido), delta: prev?fDelta(d.ticket_pedido,prev.ticket_pedido):null, note: eff.label?"nível período (pedidos não recortados)":null, cls:"k3"},
    {lbl:"Clientes ativos", val:fN(d.n_cli), delta: prev?fDelta(d.n_cli,prev.n_cli):null, note: eff.label?"nível período (não recortável por "+eff.label.split(" · ")[0].split(":")[0]+")":null, cls:"k4"},
    {lbl:"Vendedores ativos", val:fN(d.n_vend), delta: prev?fDelta(d.n_vend,prev.n_vend):null, note: eff.label?"nível período (não recortável por "+eff.label.split(" · ")[0].split(":")[0]+")":null, cls:"k5"},
  ];
  const banners = [];
  // Recorte que exige consulta ao banco (Canal/Inadimplente/Status/Cliente/Grupo+
  // hierarquia): mostra o aviso em vez de um número aproximado do cubo.
  const parcial = mesParcialInfo();
  if (parcial) banners.push(`📅 ${MESES_NOME[ST.mes]} é o <strong>${parcial.label}</strong> — o realizado cobre só os dias decorridos, então metas e comparações com meses fechados ficam proporcionalmente menores.`);
  if (recorteErro) banners.push(`⚠ Falha ao aplicar o recorte do seu acesso (<strong>${recorteErro}</strong>) — os valores estão zerados por segurança. Recarregue a página.`);
  else if (d._carregando || eff.carregando) banners.push(`⏳ Consultando no banco o recorte <strong>${eff.label || recorteLabel()}</strong> — os valores aparecem em alguns segundos.`);
  else if (eff.label && nConflict) banners.push(`⚠ Vários grupos de filtro ativos ao mesmo tempo — este cubo só recorta pelo <strong>mais específico</strong>: <strong>${eff.label}</strong>. Combinar dimensões diferentes (ex.: Gerente + Categoria) exige uma 2ª passada de ETL. Selecionar vários valores DENTRO do mesmo filtro (ex.: 2 gerentes) já soma corretamente.`);
  if (eff.monthNote) banners.push(`⚠ ${eff.monthNote}`);
  document.getElementById("vg-kpis").innerHTML = banners.map(b=>`<div class="alert" style="grid-column:1/-1">${b}</div>`).join("") + kpis.map(k=>`
    <div class="kpi ${k.cls}"><div class="kpi-stripe"></div>
      <div class="kpi-lbl">${k.lbl}</div><div class="kpi-val">${k.val}</div>
      ${k.delta?`<span class="kpi-delta ${k.delta.c}">${k.delta.s}</span>`:''}
      <div class="kpi-note">${k.note || (prevEff?vsTxt:'sem base comparável')}</div>
    </div>`).join("");

  const rpm = receitaPorMesDoRecorte(d);
  const noteMes = document.getElementById("vgMesNote");
  if (noteMes) noteMes.textContent = rpm.note || (eff.label ? `Recorte: ${eff.label}` : 'Período selecionado');
  mkChart("cVgMes",{type:"bar",data:{labels:rpm.meses.map(m=>MESES_NOME[m]),datasets:[{data:rpm.vals,backgroundColor:C.acc+"cc",borderRadius:4}]},
    options:{responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>" "+fF(c.raw)}}},scales:{y:{ticks:{callback:v=>fM(v)}}}}});

  // Mix por Categoria respeita o recorte de Gerente/Supervisor/Vendedor (cubo
  // hier_por_categoria) e o filtro de Categoria — antes vinha sempre da empresa.
  const cats = categoriaCascadeRowsFor(d, ST.mes).rows.slice().sort((a,b)=>b[1].r-a[1].r);
  mkChart("cVgCat",{type:"doughnut",data:{labels:cats.map(c=>c[0]),datasets:[{data:cats.map(c=>c[1].r),backgroundColor:P}]},
    options:{plugins:{legend:{position:"right",labels:{boxWidth:10,font:{size:10}}},tooltip:{callbacks:{label:c=>" "+c.label+": "+fF(c.raw)}}}}});

  // Só os gerentes dentro do escopo ativo (trava de acesso / cascata).
  const gers = gerenteCascadeRowsFor(d, ST.mes).rows.slice().sort((a,b)=>b[1].r-a[1].r);
  mkChart("cVgGer",{type:"bar",data:{labels:gers.map(g=>g[0]),datasets:[{data:gers.map(g=>g[1].r),backgroundColor:P.map(c=>c+"bb"),borderRadius:4}]},
    options:{indexAxis:"y",responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>" "+fF(c.raw)}}},scales:{x:{ticks:{callback:v=>fM(v)}}}}});

  // Grupos: o cubo não cruza Grupo com hierarquia, então com filtro ativo usamos o
  // por_grupo do recorte (/recorte). Sem isso, o card mostrava o total da empresa
  // (ex.: 268,9M em CIGARROS DE PALHA) dentro de um gerente de 78,0M.
  const grpRec = recorteDados();
  const grpBase = grpRec ? grpRec.por_grupo : d.por_grupo;
  const grps = Object.entries(grpBase)
    .filter(([n,v]) => (ST.grp.length===0 || ST.grp.includes(n)) && (ST.cat.length===0 || ST.cat.includes(v.categoria)))
    .sort((a,b)=>b[1].r-a[1].r).slice(0,8);
  const grpNote = document.getElementById("vgGrpNote");
  if (grpNote) grpNote.textContent = grpRec
    ? `Recorte: ${recorteLabel()}`
    : (activeFilterCount() ? 'Nível empresa — carregando o recorte…' : 'Receita no período');
  mkChart("cVgGrp",{type:"bar",data:{labels:grps.map(g=>g[0]),datasets:[{data:grps.map(g=>g[1].r),backgroundColor:C.acc2+"cc",borderRadius:4}]},
    options:{indexAxis:"y",responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>" "+fF(c.raw)}}},scales:{x:{ticks:{callback:v=>fM(v)}}}}});
}

// ── 2. COMPARATIVOS ───────────────────────────────────────────
function renderComp(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const eff = effectiveFor(d, ST.mes);
  const prevEff = prev ? effectiveFor(prev, ST.mes) : null;
  const effR = eff.r, effC = eff.c, effM = effR>0 ? 100*(1-effC/effR) : 0, effQ = eff.q;
  const prevR = prevEff ? prevEff.r : null;
  const prevM = prevEff ? (prevEff.r>0?100*(1-prevEff.c/prevEff.r):0) : null;
  const prevQ = prevEff ? prevEff.q : null;

  const prevCashMargem = prevEff ? (prevEff.r - prevEff.c) : null;
  const rows = [
    {lbl:"Receita"+(eff.label?" — "+eff.label:""), a:effR, b:prevR, f:fM},
    {lbl:"Margem %", a:effM, b:prevM, f:fPct},
    {lbl:"Cash Margem", a:effR-effC, b:prevCashMargem, f:fM},
    {lbl:"Qtde", a:effQ, b:prevQ, f:v=>v!=null?fN(v):"—"},
  ];
  if (!eff.label) rows.push(
    {lbl:"Clientes ativos", a:d.n_cli, b:prev&&prev.n_cli, f:fN},
    {lbl:"Nº Pedidos", a:d.n_pedidos, b:prev&&prev.n_pedidos, f:fN},
    {lbl:"Ticket médio", a:d.ticket_pedido, b:prev&&prev.ticket_pedido, f:fF}
  );
  const compBanner = eff.monthNote ? `⚠ ${eff.monthNote}` : (eff.label?`Recorte ativo: <strong>${eff.label}</strong> — comparado ao mesmo recorte em ${prevKey?REAL_DATA[prevKey].label:"—"}.`:"");
  document.getElementById("comp-cards").innerHTML = (compBanner?`<div class="alert" style="grid-column:1/-1">${compBanner}</div>`:"") + rows.map(r=>{
    const dl = (r.b!=null) ? fDelta(r.a,r.b) : {s:"sem base", c:"neu"};
    return `<div class="comp-card"><div class="cc-lbl">${r.lbl}</div><div class="cc-val">${r.f(r.a)}</div>
      <div class="cc-vs">${r.b!=null?("vs "+r.f(r.b)+" ("+(prev?prev.label:"")+")"):"Sem base equivalente no recorte/semestre"}</div>
      <span class="kpi-delta ${dl.c}">${dl.s}</span></div>`;
  }).join("");

  const compCharts = ["cCompMes","cCompMargem","cCompCash","cCompCat"];
  if (prev){
    const meses = Object.keys(d.por_mes).sort((a,b)=>+a-+b);
    const mesLbl = meses.map(m=>MESES_NOME[m]);
    mkChart("cCompMes",{type:"line",data:{labels:mesLbl,datasets:[
      {label:d.label,data:meses.map(m=>d.por_mes[m]?d.por_mes[m].r:null),borderColor:C.acc,backgroundColor:C.acc+"22",tension:.3,fill:true},
      {label:prev.label,data:meses.map(m=>prev.por_mes[m]?prev.por_mes[m].r:null),borderColor:C.t2,backgroundColor:"transparent",borderDash:[4,4],tension:.3}
    ]},options:{responsive:true,plugins:{legend:{position:"top",labels:{boxWidth:10,font:{size:10}}},tooltip:{callbacks:{label:c=>" "+c.dataset.label+": "+fF(c.raw)}}},scales:{y:{ticks:{callback:v=>fM(v)}}}}});
    mkChart("cCompMargem",{type:"line",data:{labels:mesLbl,datasets:[
      {label:d.label,data:meses.map(m=>d.por_mes[m]?d.por_mes[m].m:null),borderColor:C.acc2,backgroundColor:C.acc2+"22",tension:.3,fill:true},
      {label:prev.label,data:meses.map(m=>prev.por_mes[m]?prev.por_mes[m].m:null),borderColor:C.t2,backgroundColor:"transparent",borderDash:[4,4],tension:.3}
    ]},options:{responsive:true,plugins:{legend:{position:"top",labels:{boxWidth:10,font:{size:10}}},tooltip:{callbacks:{label:c=>" "+c.dataset.label+": "+fPct(c.raw)}}},scales:{y:{ticks:{callback:v=>v+"%"}}}}});
    mkChart("cCompCash",{type:"bar",data:{labels:mesLbl,datasets:[
      {label:d.label,data:meses.map(m=>d.por_mes[m]?round2c(d.por_mes[m].r-d.por_mes[m].c):null),backgroundColor:C.acc+"cc",borderRadius:4},
      {label:prev.label,data:meses.map(m=>prev.por_mes[m]?round2c(prev.por_mes[m].r-prev.por_mes[m].c):null),backgroundColor:C.t2+"aa",borderRadius:4}
    ]},options:{responsive:true,plugins:{legend:{position:"top",labels:{boxWidth:10,font:{size:10}}},tooltip:{callbacks:{label:c=>" "+c.dataset.label+": "+fF(c.raw)}}},scales:{y:{ticks:{callback:v=>fM(v)}}}}});
    const cats = Object.entries(d.por_categoria).sort((a,b)=>b[1].r-a[1].r).map(e=>e[0]);
    mkChart("cCompCat",{type:"bar",data:{labels:cats,datasets:[
      {label:d.label,data:cats.map(c=>d.por_categoria[c]?d.por_categoria[c].r:0),backgroundColor:C.acc+"cc",borderRadius:4},
      {label:prev.label,data:cats.map(c=>prev.por_categoria[c]?prev.por_categoria[c].r:0),backgroundColor:C.t2+"aa",borderRadius:4}
    ]},options:{indexAxis:"y",responsive:true,plugins:{legend:{position:"top",labels:{boxWidth:10,font:{size:10}}},tooltip:{callbacks:{label:c=>" "+c.dataset.label+": "+fF(c.raw)}}},scales:{x:{ticks:{callback:v=>fM(v)}}}}});
  } else {
    compCharts.forEach(id=>{ if (charts[id]) { charts[id].destroy(); delete charts[id]; } });
  }
}
function round2c(v){ return Math.round((v||0)*100)/100; }

// ── 3. MARGEM & CASH MARGEM ─────────────────────────────────────
// ── CASCATA Gerente → Supervisor → Vendedor ─────────────────────
// por_gerente/por_supervisor/full_vendedores são dicts PLANOS, ligados só por
// por_supervisor[].gerente e full_vendedores[].supervisor — a árvore é
// montada aqui, não vem pronta do backend. Com mês ativo, Gerente usa o cubo
// diário (monthlyGerenteAgg, mais fino); Supervisor/Vendedor usam
// realizado_por_mes (mesmo cubo mensal por entidade criado para a aba Meta),
// que já dá o valor exato do mês nesses 2 níveis — antes não existia.
function margemValueFor(d, level, name, mes){
  if (level==='gerente'){
    if (mes!=null){ const a = monthlyGerenteAgg(d, name, mes); return {r:a.r, c:a.c}; }
    const v = d.por_gerente[name]; return v ? {r:v.r, c:v.c} : {r:0,c:0};
  }
  if (mes!=null){
    const mesKey = String(mes);
    const src = d.realizado_por_mes && d.realizado_por_mes[mesKey] && d.realizado_por_mes[mesKey][level];
    if (src && src[name]) return {r:src[name].r, c:src[name].c};
    return {r:0,c:0};
  }
  const src = level==='supervisor' ? d.por_supervisor : d.full_vendedores;
  const v = src[name]; return v ? {r:v.r, c:v.c} : {r:0,c:0};
}
function margemMFrom(r,c){ return r>0 ? +(100*(1-c/r)).toFixed(2) : 0; }
// Meta Cash Margem (R$) de um nível — meta_valrentabilidade já vem pronta do
// ETL (meta de receita x margem alvo), com quebra mensal em meta.por_mes.
function metaValRentFor(d, level, name, mes){
  if (mes!=null){
    const mesKey = String(mes);
    const m = d.meta.por_mes && d.meta.por_mes[mesKey] && d.meta.por_mes[mesKey][level] && d.meta.por_mes[mesKey][level][name];
    return (m && m.meta_valrentabilidade) || 0;
  }
  const src = level==='gerente'?d.meta.por_gerente:level==='supervisor'?d.meta.por_supervisor:d.meta.por_vendedor;
  return (src[name] && src[name].meta_valrentabilidade) || 0;
}
// Meta Cash Margem por CATEGORIA — meta de receita da categoria x margem alvo
// daquela categoria especificamente (não a margem média da empresa).
function metaValRentCategoriaFor(d, mes){
  if (mes!=null) return (d.meta.por_mes_categoria_valrentabilidade && d.meta.por_mes_categoria_valrentabilidade[String(mes)]) || {};
  return d.meta.por_categoria_valrentabilidade || {};
}
function prevMargemLookup(prev, level, name, mes){
  if (!prev) return null;
  if (level==='gerente') return mes!=null ? gerenteMonthValueFor(prev, name, mes) : (prev.por_gerente[name] ? {r:prev.por_gerente[name].r, c:prev.por_gerente[name].c, m:prev.por_gerente[name].m} : null);
  if (mes!=null){
    const mesKey = String(mes);
    const src = prev.realizado_por_mes && prev.realizado_por_mes[mesKey] && prev.realizado_por_mes[mesKey][level];
    if (src && src[name]) return {r:src[name].r, c:src[name].c, m:margemMFrom(src[name].r,src[name].c)};
    return null;
  }
  const src = level==='supervisor' ? prev.por_supervisor : prev.full_vendedores;
  const pv = src[name];
  return pv ? {r:pv.r, c:pv.c, m:pv.m} : null;
}
// Meta Faturamento (meta_geral) + Meta Cash Margem (meta_valrentabilidade) de um
// nível — Meta Margem % = Meta Cash Margem ÷ Meta Faturamento (mesma fórmula
// (faturamento-custo)/faturamento, só que aplicada aos valores de META).
function nodeMetaFor(d, level, name, mes){
  const metaFat = metaGeralFor(d, level, name, mes);
  const metaCash = metaValRentFor(d, level, name, mes);
  const metaMargem = metaFat>0 ? +(metaCash/metaFat*100).toFixed(2) : 0;
  return {metaFat, metaCash, metaMargem};
}
function buildMargemHierTree(d, mes){
  const eff = effectiveGerentes(d), effSup = effectiveSupervisores(d);
  const tree = {};
  Object.keys(d.por_gerente).filter(n=>!eff||eff.has(n)).forEach(gerNome=>{
    const gv = margemValueFor(d,'gerente',gerNome,mes);
    const supChildren = {};
    Object.keys(d.por_supervisor).filter(n=>d.por_supervisor[n].gerente===gerNome && (!effSup||effSup.has(n))).forEach(supNome=>{
      const sv = margemValueFor(d,'supervisor',supNome,mes);
      const vendChildren = {};
      Object.keys(d.full_vendedores).filter(n=>d.full_vendedores[n].supervisor===supNome && (ST.vend.length===0||ST.vend.includes(n))).forEach(vendNome=>{
        const vv = margemValueFor(d,'vendedor',vendNome,mes);
        vendChildren[vendNome] = Object.assign({r:vv.r, c:vv.c, m:margemMFrom(vv.r,vv.c), children:null}, nodeMetaFor(d,'vendedor',vendNome,mes));
      });
      supChildren[supNome] = Object.assign({r:sv.r, c:sv.c, m:margemMFrom(sv.r,sv.c), children:Object.keys(vendChildren).length?vendChildren:null}, nodeMetaFor(d,'supervisor',supNome,mes));
    });
    tree[gerNome] = Object.assign({r:gv.r, c:gv.c, m:margemMFrom(gv.r,gv.c), children:Object.keys(supChildren).length?supChildren:null}, nodeMetaFor(d,'gerente',gerNome,mes));
  });
  return tree;
}
function margemBadge(m){ const cls = m>=25?"mb-hi":m>=10?"mb-md":"mb-lo"; return `<span class="${cls}">${fPct(m)}</span>`; }

// Igual a prevLookupList, mas devolve a Cash Margem (R$) do mesmo item no período
// anterior — usa o campo cash_margin quando existir (listas *_cash) ou calcula r-c.
function prevLookupListCash(prev, listName, nameKey, val){
  if (!prev || !prev[listName]) return null;
  const x = prev[listName].find(o=>o[nameKey]===val);
  if (!x) return null;
  return x.cash_margin!=null ? x.cash_margin : (x.r - x.c);
}
// Igual a prevLookupListCash, mas devolve o OBJETO inteiro (r,c,m,q,...) do item
// no período anterior — usado quando precisamos da Margem % (não só Cash Margem).
function prevLookupListFull(prev, listName, nameKey, val){
  if (!prev || !prev[listName]) return null;
  return prev[listName].find(o=>o[nameKey]===val) || null;
}

// ── 3. MARGEM & CASH MARGEM (aba fundida) ───────────────────────
// Cascata Gerente→Supervisor→Vendedor reaproveita a árvore de
// buildMargemHierTree (r,c,m,metaFat,metaCash,metaMargem por nível), agora
// numa linha só com os dois conjuntos de métrica (Cash Margem em R$ e
// Margem em %) — antes eram 2 abas/tabelas separadas.
let mcHierExpanded = new Set();
function toggleMcHier(pathKey){
  if (mcHierExpanded.has(pathKey)) mcHierExpanded.delete(pathKey); else mcHierExpanded.add(pathKey);
  renderMargemCash();
}
function mcHierRowHtml(nome, nivel, pathKey, node, prevNode){
  const hasChildren = node.children && Object.keys(node.children).length>0;
  const expanded = mcHierExpanded.has(pathKey);
  const toggle = hasChildren ? `<span class="casc-toggle" onclick="toggleMcHier('${pathKey.replace(/'/g,"\\'")}')">${expanded?'−':'+'}</span>` : '<span class="casc-toggle-spacer"></span>';
  const indent = nivel*18;
  const cm = node.r-node.c;
  const pcm = prevNode ? (prevNode.r-prevNode.c) : null;
  const pvM = prevNode ? prevNode.m : null;
  const atingCash = node.metaCash>0 ? cm/node.metaCash*100 : null;
  const atingMargem = node.metaMargem>0 ? node.m/node.metaMargem*100 : null;
  return `<tr class="casc-lvl${nivel}"><td style="padding-left:${indent}px">${toggle}${escAttr(nome)}</td>
    <td class="tv">${fF(node.r)}</td>
    <td class="tv">${node.metaCash>0?fF(node.metaCash):'<span style="color:var(--t3)">—</span>'}</td>
    <td class="tv tn">${fF(cm)}</td>
    <td class="tv">${atingBadge(atingCash)}</td>
    <td class="tv">${deltaPillSmall(cm,pcm)}</td>
    <td class="tv">${node.metaMargem>0?fPct(node.metaMargem):'<span style="color:var(--t3)">—</span>'}</td>
    <td class="tv">${margemBadge(node.m)}</td>
    <td class="tv">${atingBadge(atingMargem)}</td>
    <td class="tv">${deltaPP(node.m,pvM,false)}</td></tr>`;
}
function renderMcHierRows(prev, nodesObj, pathNames, nivel, mes, levelNames){
  const level = levelNames[nivel];
  const entries = Object.keys(nodesObj).map(name=>({name, node:nodesObj[name]})).sort((a,b)=>(b.node.r-b.node.c)-(a.node.r-a.node.c));
  let html = '';
  entries.forEach(({name,node})=>{
    const path = pathNames.concat([name]);
    const pathKey = 'MC|||'+path.join('|||');
    const prevNode = prevMargemLookup(prev, level, name, mes);
    html += mcHierRowHtml(name, nivel, pathKey, node, prevNode);
    if (node.children && mcHierExpanded.has(pathKey)){
      html += renderMcHierRows(prev, node.children, path, nivel+1, mes, levelNames);
    }
  });
  return html;
}

// Detalhe de cascata do cliente (categoria + vendedor/supervisor): com filtro
// de Mês usa top_clientes_detalhe_por_mes[mes][codigo] — cobre todo cliente
// que apareceu em QUALQUER Top 50 do mês (Cash ou Margem), então nunca falta
// cascata por causa do filtro de Mês; sem filtro usa a versão semestral
// (semestralDict = top_clientes_cash_detalhe OU top_clientes_margem_detalhe,
// uma por ranking). Sob filtro de hierarquia (Gerente/Supervisor/Vendedor) o
// cliente pode vir de outra fonte (hier_top_clientes) e ainda não ter detalhe.
function cliCascadeDetalhe(d, codigo, mes, semestralDict){
  if (mes!=null){
    const porMes = d.top_clientes_detalhe_por_mes && d.top_clientes_detalhe_por_mes[String(mes)];
    return porMes ? porMes[String(codigo)] : null;
  }
  return semestralDict && semestralDict[String(codigo)];
}
// Δ vs ano anterior por categoria do cliente (top_clientes_categoria_ano_anterior,
// mesmo intervalo de datas do ano passado) — soma os meses do período atual: 1
// mês com filtro de Mês, ou o semestre inteiro sem filtro. Não depende do
// cliente também estar no Top 50 do ano passado (ao contrário do antigo
// prevLookupListCash, que buscava numa lista Top 50 fixa).
function cliCategoriaAnoAnteriorFor(d, codigo, mes){
  const src = d.top_clientes_categoria_ano_anterior && d.top_clientes_categoria_ano_anterior[String(codigo)];
  if (!src) return null;
  if (mes!=null) return src[String(mes)] || null;
  const merged = {};
  Object.values(src).forEach(porMes=>{
    Object.entries(porMes).forEach(([cat,v])=>{
      const cur = merged[cat] || (merged[cat] = {r:0,c:0});
      cur.r += v.r; cur.c += v.c;
    });
  });
  return merged;
}
function cliCashAnoAnteriorTotal(d, codigo, mes){
  const cat = cliCategoriaAnoAnteriorFor(d, codigo, mes);
  if (!cat) return null;
  let r=0,c=0; Object.values(cat).forEach(v=>{r+=v.r;c+=v.c;});
  return {r,c};
}
// Δ vs ano anterior por categoria do vendedor (hier_por_categoria.vendedor do
// período anterior) — cubo do SEMESTRE (sem grão mensal), mesma limitação já
// documentada em outras cascatas de Vendedor/Supervisor.
function vendCategoriaAnoAnteriorFor(prev, nome, cat){
  const src = prev && prev.hier_por_categoria && prev.hier_por_categoria.vendedor && prev.hier_por_categoria.vendedor[nome];
  return src ? src[cat] : null;
}
let cashCliExpanded = new Set();
function toggleCashCli(codigo){
  if (cashCliExpanded.has(codigo)) cashCliExpanded.delete(codigo); else cashCliExpanded.add(codigo);
  renderMargemCash();
}
function tblCashCli(rows, d, prev, mes){
  return `<thead><tr><th>#</th><th>Nome</th><th class="tv">Cash Margem</th><th class="tv">Δ vs ano ant.</th><th class="tv">Faturamento</th><th class="tv">Margem %</th></tr></thead><tbody>${
    rows.map((r,i)=>{
      const cm = r.cash_margin!=null ? r.cash_margin : (r.r-r.c);
      const anoAnt = cliCashAnoAnteriorTotal(d, r.codigo, mes);
      const pv = anoAnt ? (anoAnt.r-anoAnt.c) : prevLookupListCash(prev,"top_clientes_cash","nome",r.nome);
      const det = cliCascadeDetalhe(d, r.codigo, mes, d.top_clientes_cash_detalhe);
      const hasDet = det && (Object.keys(det.categorias||{}).length || det.vendedor);
      const expanded = hasDet && cashCliExpanded.has(r.codigo);
      const toggle = hasDet ? `<span class="casc-toggle" onclick="toggleCashCli('${r.codigo}')">${expanded?'−':'+'}</span>` : '<span class="casc-toggle-spacer"></span>';
      let html = `<tr><td><span class="badge-rk ${i===0?'g1':i===1?'g2':i===2?'g3':''}">${i+1}</span></td><td class="tn">${toggle}${escAttr(r.nome)}</td><td class="tv tn">${fF(cm)}</td><td class="tv">${deltaPillSmall(cm,pv)}</td><td class="tv">${fF(r.r)}</td><td class="tv">${margemBadge(r.m)}</td></tr>`;
      if (expanded){
        if (det.vendedor){
          html += `<tr class="casc-info"><td></td><td colspan="5" style="padding-left:24px">Vendedor: <strong>${escAttr(det.vendedor.codigo)} - ${escAttr(det.vendedor.nome)}</strong> · Supervisor: <strong>${escAttr(det.vendedor.supervisor)}</strong></td></tr>`;
        }
        const catAnoAnt = cliCategoriaAnoAnteriorFor(d, r.codigo, mes) || {};
        Object.entries(det.categorias||{}).sort((a,b)=>b[1].r-a[1].r).forEach(([cat,v])=>{
          const cmCat = v.r-v.c;
          const pvCat = catAnoAnt[cat] ? (catAnoAnt[cat].r-catAnoAnt[cat].c) : null;
          html += `<tr class="casc-lvl1"><td></td><td style="padding-left:24px">${escAttr(cat)}</td><td class="tv">${fF(cmCat)}</td><td class="tv">${deltaPillSmall(cmCat,pvCat)}</td><td class="tv">${fF(v.r)}</td><td class="tv">${margemBadge(margemMFrom(v.r,v.c))}</td></tr>`;
        });
      }
      return html;
    }).join("")}</tbody>`;
}
// Vendedores por Cash Margem: sem filtro de hierarquia usa o Top 50 da empresa;
// com Gerente/Supervisor/Vendedor filtrado, mostra TODOS os vendedores daquele
// recorte (full_vendedores, sem cap) — com código antes do nome e tooltip do supervisor.
// Cascata: expande p/ mostrar Gerente/Supervisor + faturamento por categoria
// daquele vendedor (hier_por_categoria.vendedor, já existe no cubo hierárquico).
let cashVendExpanded = new Set();
function toggleCashVend(nome){
  if (cashVendExpanded.has(nome)) cashVendExpanded.delete(nome); else cashVendExpanded.add(nome);
  renderMargemCash();
}
function tblCashVend(rows, d, prev){
  return `<thead><tr><th>#</th><th>Nome</th><th class="tv">Cash Margem</th><th class="tv">Δ vs ano ant.</th><th class="tv">Faturamento</th><th class="tv">Margem %</th></tr></thead><tbody>${
    rows.map((r,i)=>{
      const label = (r.codigo?escAttr(r.codigo)+" - ":"") + escAttr(r.nome);
      const cats = d.hier_por_categoria && d.hier_por_categoria.vendedor && d.hier_por_categoria.vendedor[r.nome];
      const hasDet = cats && Object.keys(cats).length;
      const expanded = hasDet && cashVendExpanded.has(r.nome);
      const toggle = hasDet ? `<span class="casc-toggle" onclick="toggleCashVend('${r.nome.replace(/'/g,"\\'")}')">${expanded?'−':'+'}</span>` : '<span class="casc-toggle-spacer"></span>';
      let html = `<tr><td><span class="badge-rk ${i===0?'g1':i===1?'g2':i===2?'g3':''}">${i+1}</span></td><td class="tn">${toggle}<span class="hov-tip" data-tip="Supervisor: ${escAttr(r.supervisor||'—')}">${label}</span></td><td class="tv tn">${fF(r.cash_margin)}</td><td class="tv">${deltaPillSmall(r.cash_margin,r.prevCm)}</td><td class="tv">${fF(r.r)}</td><td class="tv">${margemBadge(r.m)}</td></tr>`;
      if (expanded){
        const gerente = gerenteDoVendedor(d, r.nome);
        html += `<tr class="casc-info"><td></td><td colspan="5" style="padding-left:24px">Gerente: <strong>${escAttr(gerente||'—')}</strong> · Supervisor: <strong>${escAttr(r.supervisor||'—')}</strong></td></tr>`;
        Object.entries(cats).sort((a,b)=>b[1].r-a[1].r).forEach(([cat,v])=>{
          const cmCat = v.r-v.c;
          const pvCat = vendCategoriaAnoAnteriorFor(prev, r.nome, cat);
          const pvCm = pvCat ? (pvCat.r-pvCat.c) : null;
          html += `<tr class="casc-lvl1"><td></td><td style="padding-left:24px">${escAttr(cat)}</td><td class="tv">${fF(cmCat)}</td><td class="tv">${deltaPillSmall(cmCat,pvCm)}</td><td class="tv">${fF(v.r)}</td><td class="tv">${margemBadge(v.m)}</td></tr>`;
        });
      }
      return html;
    }).join("")}</tbody>`;
}
// Top 50 Produtos por Cash Margem: quantidade vendida (unidades) com
// comparativo vs. mesmo período ano anterior.
function tblCashProd(rows, prev){
  return `<thead><tr><th>#</th><th>Nome</th><th class="tv">Cash Margem</th><th class="tv">Δ vs ano ant.</th><th class="tv">Faturamento</th><th class="tv">Margem %</th><th class="tv">Qtde Vendida</th><th class="tv">Δ Qtde (ano ant.)</th></tr></thead><tbody>${
    rows.map((r,i)=>{
      const cm = r.cash_margin!=null ? r.cash_margin : (r.r-r.c);
      const prevEntry = prevLookupListFull(prev,"top_produtos_cash","nome",r.nome);
      const pv = prevEntry ? (prevEntry.cash_margin!=null?prevEntry.cash_margin:(prevEntry.r-prevEntry.c)) : null;
      const pq = prevEntry ? prevEntry.q : null;
      return `<tr><td><span class="badge-rk ${i===0?'g1':i===1?'g2':i===2?'g3':''}">${i+1}</span></td><td class="tn">${escAttr(r.nome)}</td><td class="tv tn">${fF(cm)}</td><td class="tv">${deltaPillSmall(cm,pv)}</td><td class="tv">${fF(r.r)}</td><td class="tv">${margemBadge(r.m)}</td><td class="tv">${fN(r.q)}</td><td class="tv">${deltaPillSmall(r.q,pq)}</td></tr>`;
    }).join("")}</tbody>`;
}

// ── Top 50 por MARGEM % — ranking SEPARADO do Top 50 por Cash Margem: um
// cliente/produto/vendedor de faturamento baixo e margem alta entra aqui e
// pode não entrar no Top 50 por Cash Margem (e vice-versa). Sem meta por
// Cliente/Produto individual no ERP — só Vendedor (nível de hierarquia real)
// tem Meta Margem/%Ating; Cliente/Produto mostram só Margem realizada + Δ.
let margemCliExpanded = new Set();
function toggleMargemCli(codigo){
  if (margemCliExpanded.has(codigo)) margemCliExpanded.delete(codigo); else margemCliExpanded.add(codigo);
  renderMargemCash();
}
// Cascata igual à de tblCashCli (categoria + vendedor/supervisor responsável),
// mas usando top_clientes_margem_detalhe — clientes diferentes do Top 50 por
// Cash Margem, então precisam do próprio detalhe.
function tblMargemCli(rows, d, prev, mes){
  return `<thead><tr><th>#</th><th>Nome</th><th class="tv">Margem %</th><th class="tv">Δ Margem (p.p.)</th><th class="tv">Faturamento</th><th class="tv">Cash Margem</th></tr></thead><tbody>${
    rows.map((r,i)=>{
      const anoAnt = cliCashAnoAnteriorTotal(d, r.codigo, mes);
      let pvM;
      if (anoAnt) pvM = margemMFrom(anoAnt.r, anoAnt.c);
      else { const prevFull = prevLookupListFull(prev,"top_clientes_margem","nome",r.nome); pvM = prevFull ? prevFull.m : null; }
      const cm = r.cash_margin!=null ? r.cash_margin : (r.r-r.c);
      const det = cliCascadeDetalhe(d, r.codigo, mes, d.top_clientes_margem_detalhe);
      const hasDet = det && (Object.keys(det.categorias||{}).length || det.vendedor);
      const expanded = hasDet && margemCliExpanded.has(r.codigo);
      const toggle = hasDet ? `<span class="casc-toggle" onclick="toggleMargemCli('${r.codigo}')">${expanded?'−':'+'}</span>` : '<span class="casc-toggle-spacer"></span>';
      let html = `<tr><td><span class="badge-rk ${i===0?'g1':i===1?'g2':i===2?'g3':''}">${i+1}</span></td><td class="tn">${toggle}${escAttr(r.nome)}</td><td class="tv tn">${margemBadge(r.m)}</td><td class="tv">${deltaPP(r.m,pvM,false)}</td><td class="tv">${fF(r.r)}</td><td class="tv">${fF(cm)}</td></tr>`;
      if (expanded){
        if (det.vendedor){
          html += `<tr class="casc-info"><td></td><td colspan="5" style="padding-left:24px">Vendedor: <strong>${escAttr(det.vendedor.codigo)} - ${escAttr(det.vendedor.nome)}</strong> · Supervisor: <strong>${escAttr(det.vendedor.supervisor)}</strong></td></tr>`;
        }
        const catAnoAnt = cliCategoriaAnoAnteriorFor(d, r.codigo, mes) || {};
        Object.entries(det.categorias||{}).sort((a,b)=>b[1].r-a[1].r).forEach(([cat,v])=>{
          const cmCat = v.r-v.c;
          const pvCatM = catAnoAnt[cat] ? margemMFrom(catAnoAnt[cat].r, catAnoAnt[cat].c) : null;
          html += `<tr class="casc-lvl1"><td></td><td style="padding-left:24px">${escAttr(cat)}</td><td class="tv">${margemBadge(margemMFrom(v.r,v.c))}</td><td class="tv">${deltaPP(margemMFrom(v.r,v.c),pvCatM,false)}</td><td class="tv">${fF(v.r)}</td><td class="tv">${fF(cmCat)}</td></tr>`;
        });
      }
      return html;
    }).join("")}</tbody>`;
}
function tblMargemProd(rows, prev){
  return `<thead><tr><th>#</th><th>Nome</th><th class="tv">Margem %</th><th class="tv">Δ Margem (p.p.)</th><th class="tv">Faturamento</th><th class="tv">Cash Margem</th><th class="tv">Qtde Vendida</th><th class="tv">Δ Qtde (ano ant.)</th></tr></thead><tbody>${
    rows.map((r,i)=>{
      const prevFull = prevLookupListFull(prev,"top_produtos_margem","nome",r.nome);
      const cm = r.cash_margin!=null ? r.cash_margin : (r.r-r.c);
      return `<tr><td><span class="badge-rk ${i===0?'g1':i===1?'g2':i===2?'g3':''}">${i+1}</span></td><td class="tn">${escAttr(r.nome)}</td><td class="tv tn">${margemBadge(r.m)}</td><td class="tv">${deltaPP(r.m,prevFull?prevFull.m:null,false)}</td><td class="tv">${fF(r.r)}</td><td class="tv">${fF(cm)}</td><td class="tv">${fN(r.q)}</td><td class="tv">${deltaPillSmall(r.q,prevFull?prevFull.q:null)}</td></tr>`;
    }).join("")}</tbody>`;
}
let margemVendExpanded = new Set();
function toggleMargemVend(nome){
  if (margemVendExpanded.has(nome)) margemVendExpanded.delete(nome); else margemVendExpanded.add(nome);
  renderMargemCash();
}
// Cascata igual à de tblCashVend (Gerente/Supervisor + faturamento por categoria).
function tblMargemVend(rows, d, prev){
  return `<thead><tr><th>#</th><th>Nome</th><th class="tv">Margem %</th><th class="tv">Meta Margem %</th><th class="tv">% Ating.</th><th class="tv">Δ Margem (p.p.)</th><th class="tv">Faturamento</th><th class="tv">Cash Margem</th></tr></thead><tbody>${
    rows.map((r,i)=>{
      const label = (r.codigo?escAttr(r.codigo)+" - ":"") + escAttr(r.nome);
      const cm = r.cash_margin!=null ? r.cash_margin : (r.r-r.c);
      const ating = r.metaMargem>0 ? r.m/r.metaMargem*100 : null;
      const cats = d.hier_por_categoria && d.hier_por_categoria.vendedor && d.hier_por_categoria.vendedor[r.nome];
      const hasDet = cats && Object.keys(cats).length;
      const expanded = hasDet && margemVendExpanded.has(r.nome);
      const toggle = hasDet ? `<span class="casc-toggle" onclick="toggleMargemVend('${r.nome.replace(/'/g,"\\'")}')">${expanded?'−':'+'}</span>` : '<span class="casc-toggle-spacer"></span>';
      let html = `<tr><td><span class="badge-rk ${i===0?'g1':i===1?'g2':i===2?'g3':''}">${i+1}</span></td><td class="tn">${toggle}<span class="hov-tip" data-tip="Supervisor: ${escAttr(r.supervisor||'—')}">${label}</span></td><td class="tv tn">${margemBadge(r.m)}</td><td class="tv">${r.metaMargem>0?fPct(r.metaMargem):'<span style="color:var(--t3)">—</span>'}</td><td class="tv">${atingBadge(ating)}</td><td class="tv">${deltaPP(r.m,r.prevM,false)}</td><td class="tv">${fF(r.r)}</td><td class="tv">${fF(cm)}</td></tr>`;
      if (expanded){
        const gerente = gerenteDoVendedor(d, r.nome);
        html += `<tr class="casc-info"><td></td><td colspan="7" style="padding-left:24px">Gerente: <strong>${escAttr(gerente||'—')}</strong> · Supervisor: <strong>${escAttr(r.supervisor||'—')}</strong></td></tr>`;
        Object.entries(cats).sort((a,b)=>b[1].r-a[1].r).forEach(([cat,v])=>{
          const cmCat = v.r-v.c;
          const pvCat = vendCategoriaAnoAnteriorFor(prev, r.nome, cat);
          const pvCatM = pvCat ? margemMFrom(pvCat.r, pvCat.c) : null;
          html += `<tr class="casc-lvl1"><td></td><td style="padding-left:24px">${escAttr(cat)}</td><td class="tv">${margemBadge(v.m)}</td><td class="tv"></td><td class="tv"></td><td class="tv">${deltaPP(v.m,pvCatM,false)}</td><td class="tv">${fF(v.r)}</td><td class="tv">${fF(cmCat)}</td></tr>`;
        });
      }
      return html;
    }).join("")}</tbody>`;
}

function renderMargemCash(){
  const d = curPeriod();
  const prev = prevPeriod();
  const eff = effectiveFor(d, ST.mes);
  const prevEff = prev ? effectiveFor(prev, ST.mes) : null;
  const effR = eff.r, effC = eff.c, cash = effR - effC;
  const effM = effR>0 ? 100*(1-effC/effR) : 0;
  const prevCash = prevEff ? (prevEff.r - prevEff.c) : null;
  const prevM = prevEff ? (prevEff.r>0?100*(1-prevEff.c/prevEff.r):0) : null;
  const cashPerCliente = d.n_cli>0 ? cash/d.n_cli : 0;

  // Meta de rentabilidade (R$) = meta de receita x % de margem alvo — Meta Margem
  // (%) é a MESMA fórmula do usuário (faturamento-custo)/faturamento aplicada à
  // meta: como custo-meta = faturamento-meta − cash-margem-meta, isso se reduz a
  // metaRent.permargem (já vem ponderado por metaRentabilidade, não é média simples).
  const metaRent = metaRentabilidade(d, ST.mes);
  const metaValRent = metaRent.valor;
  const metaMargemPct = metaRent.permargem!=null ? metaRent.permargem*100 : null;
  const atingMargem = metaMargemPct>0 ? effM/metaMargemPct*100 : null;

  const kpiDefs = [
    {lbl:"Faturamento", val:fM(effR), cur:effR, prevv:prevEff?prevEff.r:null},
    {lbl:"Realizado Margem %", val:fPct(effM), cur:effM, prevv:prevM},
    {lbl:"Meta Margem %", val:metaMargemPct>0?fPct(metaMargemPct):"—",
     note:metaMargemPct>0?"meta cash margem ÷ meta faturamento":"sem meta de margem cadastrada no ERP p/ este período"},
    {lbl:"% Atingimento Margem", val:atingMargem!=null?fPct(atingMargem):"—",
     note:atingMargem!=null?`margem realizada ${fPct(effM)} vs meta ${fPct(metaMargemPct)}`:"depende da meta de margem"},
    {lbl:"Cash Margem Total", val:fM(cash), cur:cash, prevv:prevCash},
    {lbl:"Meta Cash Margem", val:metaValRent>0?fM(metaValRent):"—",
     note:metaValRent>0?`meta de receita × margem alvo (${fPct(metaMargemPct)})`:"sem meta cadastrada no ERP p/ este período"},
    {lbl:"% Atingimento Cash Margem", val:metaValRent>0?fPct(cash/metaValRent*100):"—",
     note:metaValRent>0 && mesParcialInfo() ? `${fPct(cash/(metaValRent*mesParcialInfo().pct)*100)} da meta proporcional (${mesParcialInfo().dia}/${mesParcialInfo().diasNoMes} dias)` : ""},
    {lbl:"Cash Margem / Cliente Ativo", val:fF(cashPerCliente),
     note:`${fM(cash)} ÷ ${fN(d.n_cli)} clientes${d._recorte?" do recorte":" (empresa)"}`},
  ];
  const mcBanner = eff.monthNote ? `⚠ ${eff.monthNote}` : (eff.label?`Recortado por <strong>${eff.label}</strong>`:"");
  document.getElementById("mc-kpis").innerHTML = (mcBanner?`<div class="alert" style="grid-column:1/-1">${mcBanner}</div>`:"") + kpiDefs.map((k,i)=>`
    <div class="kpi k${i%7}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-val">${k.val}</div>
      ${k.cur!=null?deltaPillSmall(k.cur,k.prevv):''}
      <div class="kpi-note">${k.note || (k.cur!=null?(ST.mes!=null?'vs. mesmo mês ano anterior':'vs. mesmo semestre ano anterior'):'')}</div>
    </div>`).join("");

  const mcTree = buildMargemHierTree(d, ST.mes);
  document.getElementById("tMcGer").innerHTML = `<thead><tr><th>Gerente / Supervisor / Vendedor</th><th class="tv">Faturamento</th><th class="tv">Meta Cash Margem</th><th class="tv">Cash Margem</th><th class="tv">% Ating.</th><th class="tv">Δ vs ano ant.</th><th class="tv">Meta Margem %</th><th class="tv">Margem %</th><th class="tv">% Ating.</th><th class="tv">Δ Margem (p.p.)</th></tr></thead><tbody>${
    renderMcHierRows(prev, mcTree, [], 0, ST.mes, ['gerente','supervisor','vendedor'])
  }</tbody>`;

  const catInfo = categoriaCascadeRowsFor(d, ST.mes);
  const catRows = catInfo.rows.sort((a,b)=>(b[1].r-b[1].c)-(a[1].r-a[1].c));
  const mcCatNotes = [];
  if (catInfo.level) mcCatNotes.push(`Recortado por ${catInfo.level} — <strong>${labelJoin(catInfo.names)}</strong>: Faturamento/Cash Margem/Margem exatos (cubo hierárquico Gerente/Supervisor/Vendedor × Categoria); Meta continua no nível empresa (meta não tem essa quebra).`);
  if (catInfo.monthNote) mcCatNotes.push(catInfo.monthNote);
  document.getElementById("mcCatNote").innerHTML = mcCatNotes.length ? `<div class="alert">${mcCatNotes.join(" ")}</div>` : "";
  const metaCashCat = metaValRentCategoriaFor(d, ST.mes);
  const metaFatCat = ST.mes!=null ? ((d.meta.por_mes_categoria&&d.meta.por_mes_categoria[ST.mes])||{}) : (d.meta.por_categoria||{});
  document.getElementById("tMcCat").innerHTML = `<thead><tr><th>Categoria</th><th class="tv">Faturamento</th><th class="tv">Meta Cash Margem</th><th class="tv">Cash Margem</th><th class="tv">% Ating.</th><th class="tv">Δ vs ano ant.</th><th class="tv">Meta Margem %</th><th class="tv">Margem %</th><th class="tv">% Ating.</th><th class="tv">Δ Margem (p.p.)</th></tr></thead><tbody>${
    catRows.map(([n,v])=>{
      const cm = v.r-v.c;
      const metaCash = metaCashCat[n]||0;
      const metaFat = metaFatCat[n]||0;
      const metaMargemCat = metaFat>0 ? metaCash/metaFat*100 : 0;
      const atingCash = metaCash>0 ? cm/metaCash*100 : null;
      const atingMargemCat = metaMargemCat>0 ? v.m/metaMargemCat*100 : null;
      const pe = ST.mes!=null ? categoriaMonthValueFor(prev, catInfo.level, catInfo.names, n, ST.mes) : categoriaValueFor(prev, catInfo.level, catInfo.names, n);
      const pcm = pe ? (pe.r-pe.c) : null;
      const pvM = pe ? pe.m : null;
      return `<tr><td class="tn">${n}</td><td class="tv">${fF(v.r)}</td><td class="tv">${metaCash>0?fF(metaCash):'<span style="color:var(--t3)">—</span>'}</td><td class="tv tn">${fF(cm)}</td><td class="tv">${atingBadge(atingCash)}</td><td class="tv">${deltaPillSmall(cm,pcm)}</td><td class="tv">${metaMargemCat>0?fPct(metaMargemCat):'<span style="color:var(--t3)">—</span>'}</td><td class="tv">${margemBadge(v.m)}</td><td class="tv">${atingBadge(atingMargemCat)}</td><td class="tv">${deltaPP(v.m,pvM,false)}</td></tr>`;
    }).join("")}</tbody>`;

  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  let cliList, prodList, cliListM, prodListM;
  // Sob filtro de Gerente/Supervisor/Vendedor, Cliente/Produto ainda usam o
  // cubo hier_top_* (só por semestre — não existe cubo mensal por hierarquia).
  const mesTopNoteHier = ST.mes!=null ? ' Os rankings de Cliente/Produto abaixo não têm dado mensal neste recorte de hierarquia — mostram o semestre inteiro, independente do filtro de Mês.' : '';
  if (level){
    cliList = topClientesFonte(d, level, names).slice().sort((a,b)=>(b.r-b.c)-(a.r-a.c));
    prodList = topProdutosFonte(d, level, names).slice().sort((a,b)=>(b.r-b.c)-(a.r-a.c));
    cliListM = topClientesFonte(d, level, names).slice().sort((a,b)=>b.m-a.m);
    prodListM = topProdutosFonte(d, level, names).slice().sort((a,b)=>b.m-a.m);
    document.getElementById("cashHierNote").innerHTML = `<div class="alert">Recortado por ${level} — <strong>${labelJoin(names)}</strong>: Cliente/Produto usam o Top 50 por Receita daquele recorte, reordenado por Cash Margem ou por Margem % (aproximação — o recorte pode não conter o cliente/produto de maior margem/cash margem da empresa como um todo).${mesTopNoteHier}</div>`;
  } else {
    // Sem filtro de hierarquia: Top 50 respeita o filtro de Mês via os cubos
    // mensais dedicados (top_clientes_cash_por_mes etc.) — antes sempre
    // mostrava o semestre inteiro mesmo com um mês selecionado.
    const mesKey = ST.mes!=null ? String(ST.mes) : null;
    const cliCashSrc = mesKey!=null ? ((d.top_clientes_cash_por_mes&&d.top_clientes_cash_por_mes[mesKey])||[]) : d.top_clientes_cash;
    const cliMargemSrc = mesKey!=null ? ((d.top_clientes_margem_por_mes&&d.top_clientes_margem_por_mes[mesKey])||[]) : d.top_clientes_margem;
    const prodCashSrc = mesKey!=null ? ((d.top_produtos_cash_por_mes&&d.top_produtos_cash_por_mes[mesKey])||[]) : d.top_produtos_cash;
    const prodMargemSrc = mesKey!=null ? ((d.top_produtos_margem_por_mes&&d.top_produtos_margem_por_mes[mesKey])||[]) : d.top_produtos_margem;
    cliList = filtrarClientes(cliCashSrc);
    prodList = prodCashSrc.filter(p=>ST.cat.length===0||ST.cat.includes(p.categoria));
    cliListM = filtrarClientes(cliMargemSrc);
    prodListM = prodMargemSrc.filter(p=>ST.cat.length===0||ST.cat.includes(p.categoria));
    document.getElementById("cashHierNote").innerHTML = "";
  }
  // Vendedor: sempre calculado a partir de full_vendedores + realizado_por_mes
  // (mesmo grão exato do mês, com ou sem filtro de hierarquia — não depende de
  // Top 50 pré-calculado). Sem filtro usa o Top 50 da empresa (slice 50); com
  // Gerente/Supervisor/Vendedor filtrado, mostra TODOS os vendedores daquele
  // recorte, sem cap.
  const effGerVend = effectiveGerentes(d), effSupVend = effectiveSupervisores(d);
  let vendRowsCash, vendRowsMargem, vendSubTxt;
  const baseVendRows = Object.entries(d.full_vendedores)
    .filter(([n,v])=>(!effGerVend||effGerVend.has(gerenteDoVendedor(d,n)))&&(!effSupVend||effSupVend.has(v.supervisor))&&(ST.vend.length===0||ST.vend.includes(n)))
    .map(([n,v])=>{
      const mv = margemValueFor(d, 'vendedor', n, ST.mes);
      const m = margemMFrom(mv.r, mv.c);
      const pe = prevMargemLookup(prev, 'vendedor', n, ST.mes);
      const metaFat = metaGeralFor(d,'vendedor',n,ST.mes), metaCash = metaValRentFor(d,'vendedor',n,ST.mes);
      return { nome:n, codigo:v.codigo, supervisor:v.supervisor, r:mv.r, c:mv.c, m, cash_margin:mv.r-mv.c,
        prevCm: pe?(pe.r-pe.c):null, prevM: pe?pe.m:null, metaFat, metaCash, metaMargem: metaFat>0?metaCash/metaFat*100:0 };
    })
    .filter(row=>level || row.r>0 || row.c>0);
  if (level){
    vendRowsCash = baseVendRows.slice().sort((a,b)=>b.cash_margin-a.cash_margin);
    vendRowsMargem = baseVendRows.slice().sort((a,b)=>b.m-a.m);
    vendSubTxt = `${baseVendRows.length} vendedores — recortado por ${level}: ${labelJoin(names)}`;
  } else {
    vendRowsCash = baseVendRows.slice().sort((a,b)=>b.cash_margin-a.cash_margin).slice(0,50);
    vendRowsMargem = baseVendRows.slice().sort((a,b)=>b.m-a.m).slice(0,50);
    vendSubTxt = ST.mes!=null ? "Top 50 (empresa, mês filtrado)" : "Top 50 (empresa)";
  }
  document.getElementById("cashVendSub").textContent = vendSubTxt;
  document.getElementById("margemVendSub").textContent = vendSubTxt;

  document.getElementById("tCashCli").innerHTML = tblCashCli(cliList.slice(0,50), d, prev, ST.mes);
  document.getElementById("tCashProd").innerHTML = tblCashProd(prodList.slice(0,50), prev);
  document.getElementById("tCashVend").innerHTML = tblCashVend(vendRowsCash, d, prev);
  document.getElementById("tMargemCli").innerHTML = tblMargemCli(cliListM.slice(0,50), d, prev, ST.mes);
  document.getElementById("tMargemProd").innerHTML = tblMargemProd(prodListM.slice(0,50), prev);
  document.getElementById("tMargemVend").innerHTML = tblMargemVend(vendRowsMargem, d, prev);
}

// ── 3B. META X REALIZADO ───────────────────────────────────────
// Meta Geral = soma das metas das 7 categorias de receita. FUMO KG, Papel e
// Produto Estratégico saíram desta aba — são PARTE da Meta Geral (não somam a
// ela) e agora têm aba própria ("Metas KG Fumo, Papel e Estratégico"),
// exibi-los aqui também duplicaria o mesmo número em duas telas.
function atingBadge(pct){
  if (pct==null) return '<span style="color:var(--t3)">—</span>';
  const cls = pct>=100?'mb-hi':pct>=90?'mb-md':'mb-lo';
  return `<span class="${cls}">${pct.toFixed(1)}%</span>`;
}
// level (opcional): quando informado, cada linha fica clicável — chama
// objFocusToggle(level, nome) para acionar o efeito cascata da aba
// Acompanhamento Objetivos (linha selecionada fica destacada).
// level (opcional): quando informado, cada linha ganha um toggle de cascata
// (+/−) que expande, embaixo da própria linha, a tabela "Meta x Realizado x
// Margem x Positivação por Categoria" (buildCategoriaTable) recortada para
// aquela entidade — mesmas colunas do painel principal da aba. Clicar
// no toggle também aciona objFocusToggle (efeito cascata: Gerente estreita a
// lista de Supervisor abaixo, Supervisor estreita a de Vendedor).
function metaTable(names, fn, level, d, prev, meses){
  return `<thead><tr><th>Nome</th><th class="tv">Meta Geral</th><th class="tv">Δ Meta</th><th class="tv">Realizado</th><th class="tv">Δ Realizado</th><th class="tv">% Ating.</th></tr></thead><tbody>${
    names.map(n=>{
      const v = fn(n);
      const ating = v.meta>0 ? v.real/v.meta*100 : null;
      const focusKey = level==='gerente'?'ger':level==='supervisor'?'sup':'vend';
      const expanded = level && objFocus[focusKey]===n;
      const nEsc = n.replace(/'/g,"\\'");
      const toggle = level ? `<span class="casc-toggle" onclick="objFocusToggle('${level}','${nEsc}')">${expanded?'−':'+'}</span>` : '';
      const trAttrs = level ? ` class="obj-focus-row${expanded?' obj-focus-sel':''}"` : '';
      let html = `<tr${trAttrs}><td class="tn">${toggle}${n}</td><td class="tv">${fF(v.meta)}</td><td class="tv">${deltaPillSmall(v.meta,v.prevMeta)}</td><td class="tv">${fF(v.real)}</td><td class="tv">${deltaPillSmall(v.real,v.prevReal)}</td><td class="tv">${atingBadge(ating)}</td></tr>`;
      if (expanded){
        const built = buildCategoriaTable(d, prev, meses, level, [n]);
        html += `<tr class="casc-info"><td colspan="6" style="padding:10px 8px 16px">
          ${built.realCatMonthNote?`<div class="alert" style="margin-bottom:8px">⚠ ${built.realCatMonthNote}</div>`:''}
          <div class="tbl-wrap"><table>${built.html}</table></div>
        </td></tr>`;
      }
      return html;
    }).join("")}</tbody>`;
}
// Meta/Realizado de um nível (gerente/supervisor/vendedor) para um NOME —
// usa o cubo mensal (meta.por_mes / realizado_por_mes) quando há mês
// selecionado, senão o total do semestre. Sem isso, qualquer filtro de
// Gerente/Supervisor/Vendedor (inclusive a trava de acesso do usuário
// logado) somava os meses já fechados do semestre em vez de mostrar só o
// mês escolhido (ex.: Julho aparecia como Julho+Agosto).
function metaGeralFor(d, level, name, mesKey){
  // Quando mesKey é um mês específico, SEMPRE fica dentro do grão mensal — se a
  // entidade não tem linha naquele mês, o valor é 0, nunca o total do semestre
  // (usado por objMetaGeralFor pra somar vários meses; cair pro semestre num
  // mês sem linha inflava a soma pelo semestre inteiro a cada mês "vazio").
  if (mesKey!=null){
    const m = d.meta.por_mes && d.meta.por_mes[mesKey] && d.meta.por_mes[mesKey][level][name];
    return m ? m.meta_geral : 0;
  }
  const src = level==='gerente'?d.meta.por_gerente:level==='supervisor'?d.meta.por_supervisor:d.meta.por_vendedor;
  return src[name] ? src[name].meta_geral : 0;
}
function realGeralFor(d, level, name, mesKey){
  if (mesKey!=null){
    const r = d.realizado_por_mes && d.realizado_por_mes[mesKey] && d.realizado_por_mes[mesKey][level][name];
    return r ? r.r : 0;
  }
  const src = level==='gerente'?d.por_gerente:level==='supervisor'?d.por_supervisor:d.full_vendedores;
  return src[name] ? src[name].r : 0;
}
// Δ vs. ano anterior: quando há mês selecionado, só compara com o MESMO mês
// do período anterior (mesma base do resto do painel) — não cai para o
// semestre, que misturaria unidades diferentes.
function prevMetaGeralFor(prev, level, name, mesKey){
  if (!prev || !prev.meta) return null;
  if (mesKey!=null) {
    const m = prev.meta.por_mes && prev.meta.por_mes[mesKey] && prev.meta.por_mes[mesKey][level][name];
    return m ? m.meta_geral : null;
  }
  const src = level==='gerente'?prev.meta.por_gerente:level==='supervisor'?prev.meta.por_supervisor:prev.meta.por_vendedor;
  return src[name] ? src[name].meta_geral : null;
}
function prevRealGeralFor(prev, level, name, mesKey){
  if (!prev) return null;
  if (mesKey!=null) {
    const r = prev.realizado_por_mes && prev.realizado_por_mes[mesKey] && prev.realizado_por_mes[mesKey][level][name];
    return r ? r.r : null;
  }
  const src = level==='gerente'?prev.por_gerente:level==='supervisor'?prev.por_supervisor:prev.full_vendedores;
  return src[name] ? src[name].r : null;
}
// ── ACOMPANHAMENTO OBJETIVOS (fusão de "Meta x Realizado" + "Acompanhamento
// de Meta") — período LOCAL desta aba, independente do filtro global de Mês
// da barra lateral (ST.mes): 'mes' = 1 mês; 'bim'/'quad' = grupo de 2/4 meses
// DENTRO do semestre selecionado (ST.per já fixa o semestre — um quadrimestre
// que cruzasse dois semestres exigiria juntar dois cubos, não suportado — ver
// alerta fixo na tela); 'custom' = qualquer combinação de meses do semestre
// atual. Todo cálculo desta aba soma exatamente objMesesSelecionados() —
// nunca o semestre inteiro (reaproveita meta.por_mes/realizado_por_mes, os
// mesmos cubos mensais por entidade criados para corrigir a Meta Geral).
// 'mes' NÃO tem estado próprio — espelha o filtro global de Mês do topo da
// tela (ST.mes), o mesmo usado por todas as outras abas. Sem isso, trocar o
// mês no filtro principal não mudava nada aqui (aba presa no mês default).
let OBJ = { modo:'mes', bim:null, custom:[] };
let _objGrupos = [];
function objSemesterMonths(){ return ST.per && ST.per.endsWith('_1') ? [1,2,3,4,5,6] : [7,8,9,10,11,12]; }
function objAvailableMonths(d){ return Object.keys((d&&d.por_mes)||{}).map(Number).sort((a,b)=>a-b); }
// Bimestre numerado pelo calendário real (1º=Jan/Fev ... 6º=Nov/Dez), não
// reiniciando em "1º" a cada semestre — no 2º semestre os índices disponíveis
// são 4º,5º,6º. Quadrimestre foi removido: o 2º Quadrimestre do calendário
// (Mai-Ago) cruzaria os dois cubos de semestre, que são bases de dados
// separadas — sem suporte nesta arquitetura (usar Personalizado nesse caso).
function objBimestres(){ const m=objSemesterMonths(); const out=[]; for(let i=0;i<m.length;i+=2) out.push(m.slice(i,i+2)); return out; }
function objBimestreOffset(){ return ST.per && ST.per.endsWith('_2') ? 3 : 0; }
function objLabelMeses(meses){ return meses.map(m=>MESES_NOME[m].slice(0,3)).join("/"); }
function objMesesSelecionados(){
  if (OBJ.modo==='mes') return ST.mes!=null ? [ST.mes] : [];
  if (OBJ.modo==='bim') return OBJ.bim || [];
  if (OBJ.modo==='sem') return objSemesterMonths();
  if (OBJ.modo==='custom') return (OBJ.custom||[]).slice().sort((a,b)=>a-b);
  return [];
}
function onObjModoChange(){ OBJ.modo = document.getElementById('fObjModo').value; renderObjetivos(); }
function objToggleCustomMes(mes, checked){
  if (checked){ if (!OBJ.custom.includes(mes)) OBJ.custom.push(mes); }
  else { OBJ.custom = OBJ.custom.filter(m=>m!==mes); }
  renderObjetivos();
}
function objSetGrupo(idx){
  const g = _objGrupos[idx];
  if (OBJ.modo==='bim') OBJ.bim = g;
  renderObjetivos();
}
function populateObjSubFiltro(d){
  const wrap = document.getElementById('objSubFiltroWrap');
  const months = objAvailableMonths(d);
  if (OBJ.modo==='mes'){
    wrap.innerHTML = ST.mes!=null
      ? `<span style="font-size:11px;color:var(--t3)">Usando o mês do filtro geral (topo da tela): <strong style="color:var(--t1)">${MESES_NOME[ST.mes]}</strong></span>`
      : `<span style="font-size:11px;color:var(--t3)">Nenhum mês selecionado no filtro geral (topo da tela).</span>`;
  } else if (OBJ.modo==='bim'){
    _objGrupos = objBimestres();
    const offset = objBimestreOffset();
    if (!OBJ.bim || !_objGrupos.some(g=>g.join(',')===OBJ.bim.join(','))) OBJ.bim = _objGrupos[0]||null;
    wrap.innerHTML = `<select class="fsel" id="fObjSub" onchange="objSetGrupo(this.selectedIndex)">${_objGrupos.map((g,i)=>`<option value="${i}" ${OBJ.bim&&OBJ.bim.join(',')===g.join(',')?'selected':''}>${offset+i+1}º Bim (${objLabelMeses(g)})</option>`).join("")}</select>`;
  } else if (OBJ.modo==='sem'){
    const sem = objSemesterMonths();
    wrap.innerHTML = `<span style="font-size:11px;color:var(--t3)">Semestre inteiro: <strong style="color:var(--t1)">${objLabelMeses(sem)}</strong></span>`;
  } else {
    const sem = objSemesterMonths();
    if (!OBJ.custom.length && months.length) OBJ.custom = [months[months.length-1]];
    wrap.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">` + sem.map(m=>`
      <label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer">
        <input type="checkbox" ${OBJ.custom.includes(m)?'checked':''} onchange="objToggleCustomMes(${m},this.checked)"> ${MESES_NOME[m].slice(0,3)}
      </label>`).join("") + `</div>`;
  }
}
// metaGeralFor/realGeralFor/prevMetaGeralFor/prevRealGeralFor (acima) já leem
// UM mês do cubo (meta.por_mes/realizado_por_mes); aqui só somam sobre o
// array de meses selecionados no filtro de Período desta aba.
function objMetaGeralFor(d, level, name, meses){ return meses.reduce((s,mes)=>s+metaGeralFor(d, level, name, String(mes)), 0); }
function objRealGeralFor(d, level, name, meses){ return meses.reduce((s,mes)=>s+realGeralFor(d, level, name, String(mes)), 0); }
function objPrevMetaGeralFor(prev, level, name, meses){
  if (!prev) return null;
  let sum=0, any=false;
  meses.forEach(mes=>{ const v=prevMetaGeralFor(prev, level, name, String(mes)); if(v!=null){sum+=v; any=true;} });
  return any?sum:null;
}
function objPrevRealGeralFor(prev, level, name, meses){
  if (!prev) return null;
  let sum=0, any=false;
  meses.forEach(mes=>{ const v=prevRealGeralFor(prev, level, name, String(mes)); if(v!=null){sum+=v; any=true;} });
  return any?sum:null;
}
// Constrói a tabela "Meta x Realizado x Margem x Positivação por Categoria"
// (Meta/Realizado/Tendência/Margem/Cash Margem/Positivação, modelo de
// referência da planilha do usuário) para uma entidade (nível+nomes) e
// período — usada tanto na tabela principal (nível ativo do filtro global)
// quanto na cascata inline de cada linha das tabelas por Gerente/Supervisor/
// Vendedor abaixo (mesmas colunas, recortadas para 1 entidade só).
// Bonificação/%Bonif x Venda ficam "—": sem fonte de dados no ETL atual.
// Positivação/Estoque Box também ficam "—" quando level!=null: não existe
// cubo hierárquico para eles (mostrar o total da empresa pareceria dado do
// recorte, mas não é). Gerente tem grão diário exato p/ Realizado
// (hier_por_dia_categoria) — Supervisor/Vendedor caem pro semestre inteiro
// (hier_por_categoria, sem grão mensal), com aviso. Meta por categoria usa
// d.meta.hier_por_mes_categoria nos 3 níveis (grão mensal exato).
function buildCategoriaTable(d, prev, meses, level, names){
  const catNames = Object.keys(d.por_categoria);

  let perMes = [];
  const realCatSel = {};
  let realCatMonthNote = null;
  if (!level){
    perMes = meses.map(mes=>{
      const catAgg = monthlyCategoriaAgg(d, mes);
      const r = catNames.reduce((s,c)=>s+((catAgg[c]&&catAgg[c].r)||0),0);
      return { mes, catAgg, r };
    });
  } else if (level==='gerente'){
    perMes = meses.map(mes=>{
      const catAgg = monthlyGerenteUnionCategoriaAgg(d, names, mes);
      const r = Object.values(catAgg).reduce((s,v)=>s+(v.r||0),0);
      return { mes, catAgg, r };
    });
  } else {
    const base = hierUnionCategoria(d, level, names);
    Object.keys(base).forEach(cat=>{ realCatSel[cat] = {r:base[cat].r, c:base[cat].c}; });
    realCatMonthNote = `Realizado por categoria sem grão mensal para ${level} — mostrando o semestre inteiro (${d.label}), independente do Período selecionado acima.`;
  }
  if (level!=='supervisor' && level!=='vendedor'){
    perMes.forEach(pm=>Object.keys(pm.catAgg).forEach(cat=>{
      if(!realCatSel[cat]) realCatSel[cat]={r:0,c:0};
      realCatSel[cat].r += pm.catAgg[cat].r||0; realCatSel[cat].c += pm.catAgg[cat].c||0;
    }));
  }

  const metaCatSel = {};
  const metaCashCatSel = {};
  if (!level){
    meses.forEach(mes=>{
      const mc = (d.meta.por_mes_categoria && d.meta.por_mes_categoria[mes]) || {};
      Object.keys(mc).forEach(cat=>{ metaCatSel[cat]=(metaCatSel[cat]||0)+mc[cat]; });
      const mcCash = metaValRentCategoriaFor(d, mes) || {};
      Object.keys(mcCash).forEach(cat=>{ metaCashCatSel[cat]=(metaCashCatSel[cat]||0)+mcCash[cat]; });
    });
  } else {
    const agg = metaCategoriaHierMesFor(d, level, names, meses);
    Object.keys(agg).forEach(cat=>{
      metaCatSel[cat]=(metaCatSel[cat]||0)+agg[cat].meta;
      metaCashCatSel[cat]=(metaCashCatSel[cat]||0)+agg[cat].metaCash;
    });
  }
  const totalMetaCat = catNames.reduce((s,c)=>s+(metaCatSel[c]||0),0);
  const totalRealCat = catNames.reduce((s,c)=>s+((realCatSel[c]&&realCatSel[c].r)||0),0);
  const totalCustoCat = catNames.reduce((s,c)=>s+((realCatSel[c]&&realCatSel[c].c)||0),0);
  const totalTrend = perMes.reduce((s,pm)=>s+tendencia(pm.r, d, pm.mes),0);

  const prevRealCatSel = {};
  if (prev){
    if (!level){
      meses.forEach(mes=>{
        const catAgg = monthlyCategoriaAgg(prev, mes);
        Object.keys(catAgg).forEach(cat=>{ const cur=prevRealCatSel[cat]||(prevRealCatSel[cat]={r:0,c:0}); cur.r+=catAgg[cat].r||0; cur.c+=catAgg[cat].c||0; });
      });
    } else if (level==='gerente'){
      meses.forEach(mes=>{
        const catAgg = monthlyGerenteUnionCategoriaAgg(prev, names, mes);
        Object.keys(catAgg).forEach(cat=>{ const cur=prevRealCatSel[cat]||(prevRealCatSel[cat]={r:0,c:0}); cur.r+=catAgg[cat].r||0; cur.c+=catAgg[cat].c||0; });
      });
    } else {
      const base = hierUnionCategoria(prev, level, names);
      Object.keys(base).forEach(cat=>{ prevRealCatSel[cat] = {r:base[cat].r, c:base[cat].c}; });
    }
  }
  const prevTotalRealCat = catNames.reduce((s,c)=>s+((prevRealCatSel[c]&&prevRealCatSel[c].r)||0),0);
  const prevTotalCustoCat = catNames.reduce((s,c)=>s+((prevRealCatSel[c]&&prevRealCatSel[c].c)||0),0);
  const totalMargemGeral = totalRealCat>0 ? 100*(1-totalCustoCat/totalRealCat) : null;
  const prevTotalMargemGeral = (prev && prevTotalRealCat>0) ? 100*(1-prevTotalCustoCat/prevTotalRealCat) : null;

  const nCliCatSel = {};
  const prevNCliCatSel = {};
  if (!level){
    meses.forEach(mes=>{
      const mc = (d.por_mes_categoria_clientes && d.por_mes_categoria_clientes[mes]) || {};
      Object.keys(mc).forEach(cat=>{ nCliCatSel[cat]=(nCliCatSel[cat]||0)+mc[cat]; });
    });
    if (prev) meses.forEach(mes=>{
      const mc = (prev.por_mes_categoria_clientes && prev.por_mes_categoria_clientes[mes]) || {};
      Object.keys(mc).forEach(cat=>{ prevNCliCatSel[cat]=(prevNCliCatSel[cat]||0)+mc[cat]; });
    });
  }

  function catRow(nome, metaVal, r, c, prevR, prevC, trend, metaCash, nCliCat, prevNCliCat){
    const pctReal = metaVal>0 ? r/metaVal*100 : null;
    const pctTrend = metaVal>0 ? trend/metaVal*100 : null;
    const margem = r>0 ? 100*(1-c/r) : null;
    const prevMargem = (prevR!=null && prevR>0) ? 100*(1-prevC/prevR) : null;
    const pesoMeta = totalMetaCat>0 ? metaVal/totalMetaCat*100 : 0;
    const pesoReal = totalRealCat>0 ? r/totalRealCat*100 : 0;
    const cash = r-c;
    const pctRealCash = metaCash>0 ? cash/metaCash*100 : null;
    const estoque = (REAL_DATA._estoque && REAL_DATA._estoque.por_categoria[nome]) ? REAL_DATA._estoque.por_categoria[nome].valor_carga : null;
    return `<tr><td class="tv">${pesoMeta.toFixed(1)}%</td><td class="tv">${pesoReal.toFixed(1)}%</td><td class="tn">${nome}</td>
      <td class="tv">${fF(metaVal)}</td><td class="tv">${fF(r)}</td><td class="tv">${atingBadge(pctReal)}</td>
      <td class="tv">${fF(trend)}</td><td class="tv">${atingBadge(pctTrend)}</td>
      <td class="tv">${prevR!=null?fF(prevR):'<span style="color:var(--t3)">sem base</span>'}</td>
      <td class="tv">${deltaPillSmall(r,prevR)}</td>
      <td class="tv">${metaCash>0?fF(metaCash):'<span style="color:var(--t3)">—</span>'}</td>
      <td class="tv">${fF(cash)}</td>
      <td class="tv">${atingBadge(pctRealCash)}</td>
      <td class="tv">${margem!=null?margemBadge(margem):'<span style="color:var(--t3)">—</span>'}</td>
      <td class="tv">${prevMargem!=null?fPct(prevMargem):'<span style="color:var(--t3)">sem base</span>'}</td>
      <td class="tv">${(margem!=null&&prevMargem!=null)?deltaPP(margem,prevMargem,false):'<span style="color:var(--t3)">sem base</span>'}</td>
      <td class="tv">${nCliCat!=null?fN(nCliCat):'<span style="color:var(--t3)">—</span>'}</td><td class="tv">${prevNCliCat!=null?fN(prevNCliCat):'<span style="color:var(--t3)">—</span>'}</td>
      <td class="tv">${nCliCat!=null?deltaPillSmall(nCliCat,prevNCliCat):'<span style="color:var(--t3)">—</span>'}</td>
      <td class="tv"><span style="color:var(--t3)">—</span></td><td class="tv"><span style="color:var(--t3)">—</span></td>
      <td class="tv">${estoque!=null?fF(estoque):'<span style="color:var(--t3)">—</span>'}</td></tr>`;
  }
  const catBodyRows = catNames.slice().sort((a,b)=>(metaCatSel[b]||0)-(metaCatSel[a]||0)).map(cat=>{
    const agg = realCatSel[cat]||{r:0,c:0}; const pagg = prevRealCatSel[cat];
    const trend = perMes.reduce((s,pm)=>s+tendencia((pm.catAgg[cat]&&pm.catAgg[cat].r)||0, d, pm.mes),0);
    return catRow(cat, metaCatSel[cat]||0, agg.r, agg.c, pagg?pagg.r:null, pagg?pagg.c:null, trend, metaCashCatSel[cat]||0, level?null:(nCliCatSel[cat]||0), level?null:(prevNCliCatSel[cat]||0));
  }).join("");
  const totalNCli = level?null:catNames.reduce((s,c)=>s+(nCliCatSel[c]||0),0);
  const prevTotalNCli = level?null:catNames.reduce((s,c)=>s+(prevNCliCatSel[c]||0),0);
  const totalMetaCash = catNames.reduce((s,c)=>s+(metaCashCatSel[c]||0),0);
  const totalCash = totalRealCat-totalCustoCat;
  const totalRow = `<tr style="font-weight:700"><td class="tv">100,0%</td><td class="tv">100,0%</td><td class="tn">TOTAL GERAL</td>
    <td class="tv">${fF(totalMetaCat)}</td><td class="tv">${fF(totalRealCat)}</td><td class="tv">${atingBadge(totalMetaCat>0?totalRealCat/totalMetaCat*100:null)}</td>
    <td class="tv">${fF(totalTrend)}</td><td class="tv">${atingBadge(totalMetaCat>0?totalTrend/totalMetaCat*100:null)}</td>
    <td class="tv">${prev?fF(prevTotalRealCat):'<span style="color:var(--t3)">sem base</span>'}</td>
    <td class="tv">${deltaPillSmall(totalRealCat,prev?prevTotalRealCat:null)}</td>
    <td class="tv">${totalMetaCash>0?fF(totalMetaCash):'<span style="color:var(--t3)">—</span>'}</td>
    <td class="tv">${fF(totalCash)}</td>
    <td class="tv">${atingBadge(totalMetaCash>0?totalCash/totalMetaCash*100:null)}</td>
    <td class="tv">${totalMargemGeral!=null?margemBadge(totalMargemGeral):'<span style="color:var(--t3)">—</span>'}</td>
    <td class="tv">${prevTotalMargemGeral!=null?fPct(prevTotalMargemGeral):'<span style="color:var(--t3)">sem base</span>'}</td>
    <td class="tv">${(totalMargemGeral!=null&&prevTotalMargemGeral!=null)?deltaPP(totalMargemGeral,prevTotalMargemGeral,false):'<span style="color:var(--t3)">sem base</span>'}</td>
    <td class="tv">${totalNCli!=null?fN(totalNCli):'<span style="color:var(--t3)">—</span>'}</td><td class="tv">${prevTotalNCli!=null?fN(prevTotalNCli):'<span style="color:var(--t3)">—</span>'}</td>
    <td class="tv">${totalNCli!=null?deltaPillSmall(totalNCli,prevTotalNCli):'<span style="color:var(--t3)">—</span>'}</td>
    <td class="tv"><span style="color:var(--t3)">—</span></td><td class="tv"><span style="color:var(--t3)">—</span></td>
    <td class="tv"><span style="color:var(--t3)">—</span></td></tr>`;
  const html = `<thead><tr><th>% Peso Meta</th><th>% Peso Real</th><th>Categoria</th><th class="tv">Meta</th><th class="tv">Realizado</th><th class="tv">% Real</th><th class="tv">Tendência</th><th class="tv">% Tendência</th><th class="tv">Realizado ano ant.</th><th class="tv">Δ Fat. vs ano ant.</th><th class="tv">Meta Cash Margem</th><th class="tv">Real Cash Margem</th><th class="tv">% Real Cash Margem</th><th class="tv">Margem %</th><th class="tv">Margem % ano ant.</th><th class="tv">Δ Margem vs ano ant.</th><th class="tv">Positivação</th><th class="tv">Positivação ano ant.</th><th class="tv">Δ Positivação</th><th class="tv">Bonificação</th><th class="tv">% Bonif. x Venda</th><th class="tv">Estoque Box (snapshot)</th></tr></thead><tbody>${catBodyRows}${totalRow}</tbody>`;

  return { html, totalMetaCat, totalRealCat, totalCustoCat, totalTrend, prevTotalRealCat, prevTotalCustoCat, totalMargemGeral, prevTotalMargemGeral, realCatMonthNote };
}
function renderObjetivos(){
  const d = curPeriod();
  const prev = prevPeriod();
  populateObjSubFiltro(d);
  if (!d.meta){
    document.getElementById('obj-kpis').innerHTML = '<div class="alert">Sem dados de meta para este período.</div>';
    ['tObjCat','tObjGer','tObjSup','tObjVend'].forEach(id=>document.getElementById(id).innerHTML='');
    return;
  }
  const meses = objMesesSelecionados();
  if (!meses.length){
    document.getElementById('objSub').textContent = "Selecione ao menos um mês no filtro de Período.";
    document.getElementById('obj-kpis').innerHTML = '';
    ['tObjCat','tObjGer','tObjSup','tObjVend'].forEach(id=>document.getElementById(id).innerHTML='');
    return;
  }
  const ano = meses.map(m=>monthYearFor(d,m)).find(Boolean);
  document.getElementById('objSub').textContent = `${objLabelMeses(meses)}${ano?"/"+ano:""} — ${d.label}` + (prev?` · comparado ao(s) mesmo(s) mês(es) de ${prev.label}`:" · sem semestre equivalente no ano anterior");

  // Meses do Período selecionado sem NENHUM dado no ERP (nem meta nem venda) —
  // normalmente meses futuros ainda não fechados/cadastrados. Sem este aviso,
  // um Bimestre/Semestre parecia "não respeitar o filtro" quando na verdade os
  // totais já eram só dos meses que existem no ERP (os demais somam 0).
  const mesesSemDados = meses.filter(m=>!(d.por_mes && d.por_mes[m]) && !(d.meta.por_mes_categoria && d.meta.por_mes_categoria[m]));
  const mesesSemDadosNote = mesesSemDados.length
    ? `⚠ ${objLabelMeses(mesesSemDados)}/${ano||''} ainda ${mesesSemDados.length>1?'não têm meta nem venda cadastrada no ERP (provavelmente meses futuros)':'não tem meta nem venda cadastrada no ERP (provavelmente mês futuro)'} — o total do período soma só os meses com dado real.`
    : '';

  const hasProdOrCliFilter = ST.grp.length || ST.cli.length;
  let scope = null;
  if (ST.vend.length){
    let mg=0,rg=0; ST.vend.forEach(v=>{ mg+=objMetaGeralFor(d,'vendedor',v,meses); rg+=objRealGeralFor(d,'vendedor',v,meses); });
    scope = {label:"Vendedor: "+labelJoin(ST.vend), metaGeral:mg, realGeral:rg};
  } else if (ST.sup.length){
    let mg=0,rg=0; ST.sup.forEach(sName=>{ mg+=objMetaGeralFor(d,'supervisor',sName,meses); rg+=objRealGeralFor(d,'supervisor',sName,meses); });
    scope = {label:"Supervisor: "+labelJoin(ST.sup), metaGeral:mg, realGeral:rg};
  } else if (ST.ger.length){
    let mg=0,rg=0; ST.ger.forEach(g=>{ mg+=objMetaGeralFor(d,'gerente',g,meses); rg+=objRealGeralFor(d,'gerente',g,meses); });
    scope = {label:"Gerente: "+labelJoin(ST.ger), metaGeral:mg, realGeral:rg};
  }

  // ── por Categoria: precisa respeitar TANTO o Período (meses) QUANTO o filtro
  // de hierarquia (Gerente/Supervisor/Vendedor) — antes só respeitava o Período,
  // e sob filtro de Gerente/Supervisor/Vendedor mostrava sempre o total da
  // empresa (Meta/Realizado/Margem por categoria divergentes do KPI acima, que
  // já usa scope.metaGeral/realGeral corretamente recortado). A lógica em si
  // vive em buildCategoriaTable() — reaproveitada também pela cascata inline
  // das tabelas por Gerente/Supervisor/Vendedor abaixo (mesmas colunas, só
  // recortada para 1 entidade).
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  const built = buildCategoriaTable(d, prev, meses, level, names);
  const { totalMetaCat, totalRealCat, totalTrend, prevTotalRealCat, totalMargemGeral, prevTotalMargemGeral, realCatMonthNote } = built;

  const totalMetaGeral = scope ? scope.metaGeral : totalMetaCat;
  const totalRealGeral = scope ? scope.realGeral : totalRealCat;
  const totalAtingGeral = totalMetaGeral>0 ? totalRealGeral/totalMetaGeral*100 : null;
  const totalTrendAting = totalMetaGeral>0 ? totalTrend/totalMetaGeral*100 : null;

  const objBanner = [
    scope ? (level==='gerente'
      ? `Recortado por <strong>${scope.label}</strong> — Tendência não aparece no resumo acima, mas está disponível na tabela por Categoria abaixo (Gerente tem dado diário).`
      : `Recortado por <strong>${scope.label}</strong> — Tendência não disponível com este filtro (requer dado diário, só existe no nível empresa e Gerente).`) : null,
    realCatMonthNote,
  ].filter(Boolean).join(' ');
  document.getElementById('obj-kpis').innerHTML =
    (mesesSemDadosNote?`<div class="alert" style="grid-column:1/-1">${mesesSemDadosNote}</div>`:"") +
    (objBanner?`<div class="alert" style="grid-column:1/-1">${objBanner}</div>`:"") +
    (hasProdOrCliFilter?`<div class="alert" style="grid-column:1/-1">⚠ Filtro de Categoria/Grupo/Cliente é ignorado nesta aba (a meta não tem essa granularidade) — mostrando o total do período${scope?" recortado por "+scope.label:""}.</div>`:"") +
    (totalMetaGeral<=0
      ? `<div class="alert" style="grid-column:1/-1">Sem meta cadastrada no ERP para este recorte/período.</div>`
      : (scope ? [
          {lbl:"Meta Geral", val:fM(totalMetaGeral)},
          {lbl:"Realizado Geral", val:fM(totalRealGeral)},
          {lbl:"% Atingimento Geral", val: totalAtingGeral!=null?totalAtingGeral.toFixed(1)+"%":"—"},
        ] : [
          {lbl:"Meta Geral", val:fM(totalMetaGeral)},
          {lbl:"Realizado", val:fM(totalRealGeral), cur:totalRealGeral, prevv: prev?prevTotalRealCat:null},
          {lbl:"% Realizado", val: totalAtingGeral!=null?totalAtingGeral.toFixed(1)+"%":"—"},
          {lbl:"Tendência (fechamento)", val:fM(totalTrend)},
          {lbl:"% Tendência", val: totalTrendAting!=null?totalTrendAting.toFixed(1)+"%":"—"},
          {lbl:"Margem", val:fPct(totalMargemGeral), cur:totalMargemGeral, prevv:prevTotalMargemGeral},
        ]).map((k,i)=>`<div class="kpi k${i%7}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-val">${k.val}</div>
        ${k.cur!=null?deltaPillSmall(k.cur,k.prevv):''}
        <div class="kpi-note">${k.cur!=null?'vs. mesmo(s) mês(es) ano anterior':''}</div></div>`).join(""));

  // ── por Gerente / Supervisor / Vendedor (Meta Geral, somada nos meses
  // selecionados) — cada linha é clicável (efeito cascata): clicar num Gerente
  // filtra a tabela de Supervisor abaixo aos seus supervisores, clicar num
  // Supervisor filtra a de Vendedor, e a entidade mais profunda selecionada
  // alimenta o painel "Detalhe por Categoria" no rodapé (objFocus).
  const effGerMeta = effectiveGerentes(d);
  const gerRows = Object.keys(d.meta.por_gerente).filter(n=>!effGerMeta||effGerMeta.has(n)).sort((a,b)=>objMetaGeralFor(d,'gerente',b,meses)-objMetaGeralFor(d,'gerente',a,meses));
  document.getElementById('tObjGer').innerHTML = metaTable(gerRows, n=>({
    meta:objMetaGeralFor(d,'gerente',n,meses), real:objRealGeralFor(d,'gerente',n,meses),
    prevMeta: objPrevMetaGeralFor(prev,'gerente',n,meses), prevReal: objPrevRealGeralFor(prev,'gerente',n,meses),
  }), 'gerente', d, prev, meses);

  const effSupMeta = effectiveSupervisores(d);
  const supRowsAll = Object.keys(d.meta.por_supervisor).filter(n=>(!effSupMeta||effSupMeta.has(n))&&(!effGerMeta||effGerMeta.has(d.meta.por_supervisor[n].gerente)));
  const supRows = supRowsAll.filter(n=>!objFocus.ger || d.meta.por_supervisor[n].gerente===objFocus.ger).sort((a,b)=>objMetaGeralFor(d,'supervisor',b,meses)-objMetaGeralFor(d,'supervisor',a,meses));
  document.getElementById('objSupSub').textContent = objFocus.ger ? `Supervisores de ${objFocus.ger}` : `${supRows.length} supervisores`;
  document.getElementById('tObjSup').innerHTML = metaTable(supRows, n=>({
    meta:objMetaGeralFor(d,'supervisor',n,meses), real:objRealGeralFor(d,'supervisor',n,meses),
    prevMeta: objPrevMetaGeralFor(prev,'supervisor',n,meses), prevReal: objPrevRealGeralFor(prev,'supervisor',n,meses),
  }), 'supervisor', d, prev, meses);

  const vendRowsAll = Object.keys(d.meta.por_vendedor).filter(n=>(ST.vend.length===0||ST.vend.includes(n))&&(!effSupMeta||effSupMeta.has(d.meta.por_vendedor[n].supervisor)));
  const vendRows = vendRowsAll.filter(n=>{
    if (objFocus.sup) return d.meta.por_vendedor[n].supervisor===objFocus.sup;
    if (objFocus.ger) return supRowsAll.filter(s=>d.meta.por_supervisor[s].gerente===objFocus.ger).includes(d.meta.por_vendedor[n].supervisor);
    return true;
  }).sort((a,b)=>objMetaGeralFor(d,'vendedor',b,meses)-objMetaGeralFor(d,'vendedor',a,meses));
  document.getElementById('objVendSub').textContent = `${vendRows.length} vendedores com meta cadastrada no período` + (objFocus.sup?` — de ${objFocus.sup}`:objFocus.ger?` — de ${objFocus.ger}`:'');
  document.getElementById('tObjVend').innerHTML = metaTable(vendRows, n=>({
    meta:objMetaGeralFor(d,'vendedor',n,meses), real:objRealGeralFor(d,'vendedor',n,meses),
    prevMeta: objPrevMetaGeralFor(prev,'vendedor',n,meses), prevReal: objPrevRealGeralFor(prev,'vendedor',n,meses),
  }), 'vendedor', d, prev, meses);

  // Positivação (clientes ativos) é COUNT DISTINCT por mês — somar vários meses
  // conta 2x um cliente que comprou em mais de um mês (não há como deduplicar
  // no front sem a lista de clientes por mês); avisamos quando isso se aplica.
  document.getElementById('objCashNote').innerHTML = (!level && meses.length>1)
    ? `<div class="alert">⚠ Positivação somada de ${meses.length} meses (${objLabelMeses(meses)}) — não deduplicada entre meses: um cliente que comprou em mais de um mês do período é contado mais de uma vez.</div>`
    : (level ? `<div class="alert">⚠ Positivação por categoria não está disponível recortada por ${level} — sem esse cubo no ETL. Mostrando "—".</div>` : '');

  document.getElementById('tObjCat').innerHTML = built.html;
}

// objFocus: efeito cascata Gerente→Supervisor→Vendedor. Clicar numa linha das
// tabelas por Gerente/Supervisor/Vendedor abre inline (via metaTable) a
// tabela de categoria daquela entidade, E estreita a tabela do nível abaixo
// (Gerente selecionado → só os supervisores dele; Supervisor selecionado → só
// os vendedores dele) — ver renderObjetivos.
let objFocus = { ger:null, sup:null, vend:null };
function objFocusToggle(level, nome){
  if (level==='gerente'){ objFocus.ger = (objFocus.ger===nome?null:nome); objFocus.sup=null; objFocus.vend=null; }
  else if (level==='supervisor'){ objFocus.sup = (objFocus.sup===nome?null:nome); objFocus.vend=null; }
  else if (level==='vendedor'){ objFocus.vend = (objFocus.vend===nome?null:nome); }
  renderObjetivos();
}

// ── 3B1B. METAS KG FUMO, PAPEL E PRODUTO ESTRATÉGICO ────────────
// As 3 são PARTE da Meta Geral (o backend já as exclui de meta_geral —
// codmetacategoria not in (12,13,14)) — nunca somar a ela. Realizado de
// Produto Estratégico = soma do campo "estrategico" (Total dos produtos da
// lista cifalcomercial.produtos_estrategicos) em todas as categorias onde
// aparecer, não uma categoria isolada. Papel é medido em QUANTIDADE (unidade
// de embalagem padrão), não em R$ — meta e realizado usam fN, sem "R$".
// Com mês selecionado, usa o cubo mensal por entidade (meta.por_mes /
// realizado_por_mes) — a mesma correção aplicada à aba Meta x Realizado.
// level (opcional, 'gerente'|'supervisor'): torna cada linha clicável — efeito
// cascata igual ao da aba Acompanhamento Objetivos (metaExtraFocus), clicar num
// Gerente estreita a tabela de Supervisor abaixo aos supervisores dele, clicar
// num Supervisor estreita a de Vendedor. Sem quebra por categoria aqui (KG
// Fumo/Papel/Estratégico já são métricas únicas, não por categoria) — por
// isso não há tabela aninhada como em Acompanhamento Objetivos, só o realce/
// filtro da linha selecionada.
function metaExtraTable(names, fn, level){
  return `<thead><tr><th>Nome</th><th class="tv">Meta KG Fumo</th><th class="tv">Realiz. KG Fumo</th><th class="tv">% Ating. KG</th><th class="tv">Meta Papel (Qtd)</th><th class="tv">Realizado Papel (Qtd)</th><th class="tv">% Ating. Papel</th><th class="tv">Meta Estratégico</th><th class="tv">Realizado Estratégico</th><th class="tv">% Ating. Estrat.</th></tr></thead><tbody>${
    names.map(n=>{
      const v = fn(n);
      const atingKg = v.metaKg>0 ? v.realKg/v.metaKg*100 : null;
      const atingPapel = v.metaPapel>0 ? v.realPapel/v.metaPapel*100 : null;
      const atingEst = v.metaEst>0 ? v.realEst/v.metaEst*100 : null;
      const focusKey = level==='gerente'?'ger':'sup';
      const selected = level && metaExtraFocus[focusKey]===n;
      const trAttrs = level ? ` class="obj-focus-row${selected?' obj-focus-sel':''}" style="cursor:pointer" onclick="metaExtraFocusToggle('${level}','${n.replace(/'/g,"\\'")}')"` : '';
      return `<tr${trAttrs}><td class="tn">${n}</td><td class="tv">${fN(v.metaKg)} kg</td><td class="tv">${fN(v.realKg)} kg</td><td class="tv">${atingBadge(atingKg)}</td><td class="tv">${fN(v.metaPapel)}</td><td class="tv">${fN(v.realPapel)}</td><td class="tv">${atingBadge(atingPapel)}</td><td class="tv">${fF(v.metaEst)}</td><td class="tv">${fF(v.realEst)}</td><td class="tv">${atingBadge(atingEst)}</td></tr>`;
    }).join("")}</tbody>`;
}
// efeito cascata Gerente→Supervisor→Vendedor desta aba (independente do
// objFocus da aba Acompanhamento Objetivos — cada aba mantém sua própria
// seleção, já que não têm relação entre si).
let metaExtraFocus = { ger:null, sup:null };
function metaExtraFocusToggle(level, nome){
  if (level==='gerente'){ metaExtraFocus.ger = (metaExtraFocus.ger===nome?null:nome); metaExtraFocus.sup=null; }
  else if (level==='supervisor'){ metaExtraFocus.sup = (metaExtraFocus.sup===nome?null:nome); }
  renderMetasExtra();
}
// meta_kg cobre o mesmo valor de meta_fumokg (o backend grava os dois nomes
// para a mesma categoria 13) — usar meta_kg uniformemente porque é o único
// presente no cubo mensal (meta.por_mes não tem "meta_fumokg").
function metaExtraFor(d, level, name, mesKey, metaField){
  if (mesKey!=null){
    const m = d.meta.por_mes && d.meta.por_mes[mesKey] && d.meta.por_mes[mesKey][level][name];
    return (m && m[metaField]) || 0;
  }
  const src = level==='gerente'?d.meta.por_gerente:level==='supervisor'?d.meta.por_supervisor:d.meta.por_vendedor;
  return (src[name] && src[name][metaField]) || 0;
}
function realExtraFor(d, level, name, mesKey, realField){
  if (mesKey!=null){
    const r = d.realizado_por_mes && d.realizado_por_mes[mesKey] && d.realizado_por_mes[mesKey][level][name];
    return (r && r[realField]) || 0;
  }
  const src = level==='gerente'?d.por_gerente:level==='supervisor'?d.por_supervisor:d.full_vendedores;
  return (src[name] && src[name][realField]) || 0;
}
function renderMetasExtra(){
  const d = curPeriod();
  if (!d.meta){ document.getElementById('metaExtra-kpis').innerHTML='<div class="alert">Sem dados de meta para este período.</div>'; ['tMetaExtraGer','tMetaExtraSup','tMetaExtraVend'].forEach(id=>document.getElementById(id).innerHTML=''); return; }

  const hasProdOrCliFilter = ST.grp.length || ST.cli.length;
  const monthActive = ST.mes!=null;
  const mesKey = monthActive ? String(ST.mes) : null;
  const gerNames = Object.keys(d.meta.por_gerente);

  let scope = null;
  if (ST.vend.length){
    let mk=0,rk=0,mp=0,rp=0,me=0,re=0;
    ST.vend.forEach(v=>{
      mk+=metaExtraFor(d,'vendedor',v,mesKey,'meta_kg'); rk+=realExtraFor(d,'vendedor',v,mesKey,'rkg');
      mp+=metaExtraFor(d,'vendedor',v,mesKey,'meta_papel'); rp+=realExtraFor(d,'vendedor',v,mesKey,'rp');
      me+=metaExtraFor(d,'vendedor',v,mesKey,'meta_estrategico'); re+=realExtraFor(d,'vendedor',v,mesKey,'rest');
    });
    scope = {label:"Vendedor: "+labelJoin(ST.vend), metaKg:mk, realKg:rk, metaPapel:mp, realPapel:rp, metaEst:me, realEst:re};
  } else if (ST.sup.length){
    let mk=0,rk=0,mp=0,rp=0,me=0,re=0;
    ST.sup.forEach(sName=>{
      mk+=metaExtraFor(d,'supervisor',sName,mesKey,'meta_kg'); rk+=realExtraFor(d,'supervisor',sName,mesKey,'rkg');
      mp+=metaExtraFor(d,'supervisor',sName,mesKey,'meta_papel'); rp+=realExtraFor(d,'supervisor',sName,mesKey,'rp');
      me+=metaExtraFor(d,'supervisor',sName,mesKey,'meta_estrategico'); re+=realExtraFor(d,'supervisor',sName,mesKey,'rest');
    });
    scope = {label:"Supervisor: "+labelJoin(ST.sup), metaKg:mk, realKg:rk, metaPapel:mp, realPapel:rp, metaEst:me, realEst:re};
  } else if (ST.ger.length){
    let mk=0,rk=0,mp=0,rp=0,me=0,re=0;
    ST.ger.forEach(g=>{
      mk+=metaExtraFor(d,'gerente',g,mesKey,'meta_kg'); rk+=realExtraFor(d,'gerente',g,mesKey,'rkg');
      mp+=metaExtraFor(d,'gerente',g,mesKey,'meta_papel'); rp+=realExtraFor(d,'gerente',g,mesKey,'rp');
      me+=metaExtraFor(d,'gerente',g,mesKey,'meta_estrategico'); re+=realExtraFor(d,'gerente',g,mesKey,'rest');
    });
    scope = {label:"Gerente: "+labelJoin(ST.ger), metaKg:mk, realKg:rk, metaPapel:mp, realPapel:rp, metaEst:me, realEst:re};
  }

  const totalMetaKg = scope ? scope.metaKg : gerNames.reduce((a,n)=>a+metaExtraFor(d,'gerente',n,mesKey,'meta_kg'),0);
  const totalRealKg = scope ? scope.realKg : gerNames.reduce((a,n)=>a+realExtraFor(d,'gerente',n,mesKey,'rkg'),0);
  const totalMetaPapel = scope ? scope.metaPapel : gerNames.reduce((a,n)=>a+metaExtraFor(d,'gerente',n,mesKey,'meta_papel'),0);
  const totalRealPapel = scope ? scope.realPapel : gerNames.reduce((a,n)=>a+realExtraFor(d,'gerente',n,mesKey,'rp'),0);
  const totalMetaEst = scope ? scope.metaEst : gerNames.reduce((a,n)=>a+metaExtraFor(d,'gerente',n,mesKey,'meta_estrategico'),0);
  const totalRealEst = scope ? scope.realEst : gerNames.reduce((a,n)=>a+realExtraFor(d,'gerente',n,mesKey,'rest'),0);

  const atingKg = totalMetaKg>0 ? totalRealKg/totalMetaKg*100 : null;
  const atingPapel = totalMetaPapel>0 ? totalRealPapel/totalMetaPapel*100 : null;
  const atingEst = totalMetaEst>0 ? totalRealEst/totalMetaEst*100 : null;

  document.getElementById('metaExtra-kpis').innerHTML =
    (scope?`<div class="alert" style="grid-column:1/-1">Recortado por <strong>${scope.label}</strong>${monthActive?" · Mês: "+MESES_NOME[ST.mes]:""}</div>`:(monthActive?`<div class="alert" style="grid-column:1/-1">Recortado por Mês: <strong>${MESES_NOME[ST.mes]}</strong></div>`:"")) +
    (hasProdOrCliFilter?`<div class="alert" style="grid-column:1/-1">⚠ Filtro de Categoria/Grupo/Cliente é ignorado nesta aba (a meta não tem essa granularidade) — mostrando o total do período${scope?" recortado por "+scope.label:""}.</div>`:"") +
    [
      {lbl:"Meta KG Fumo", val: fN(totalMetaKg)+" kg"},
      {lbl:"Realizado KG Fumo", val: fN(totalRealKg)+" kg"},
      {lbl:"% Atingimento KG Fumo", val: atingKg!=null?atingKg.toFixed(1)+"%":"—"},
      {lbl:"Meta Papel (Qtd)", val: fN(totalMetaPapel)},
      {lbl:"Realizado Papel (Qtd)", val: fN(totalRealPapel)},
      {lbl:"% Atingimento Papel", val: atingPapel!=null?atingPapel.toFixed(1)+"%":"—"},
      {lbl:"Meta Produto Estratégico", val: fF(totalMetaEst)},
      {lbl:"Realizado Produto Estratégico", val: fF(totalRealEst)},
      {lbl:"% Atingimento Estratégico", val: atingEst!=null?atingEst.toFixed(1)+"%":"—"},
    ].map((k,i)=>`<div class="kpi k${i%7}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-val">${k.val}</div></div>`).join("");

  const effGerMeta = effectiveGerentes(d);
  const gerRows = gerNames.filter(n=>!effGerMeta||effGerMeta.has(n)).sort((a,b)=>metaExtraFor(d,'gerente',b,mesKey,'meta_papel')-metaExtraFor(d,'gerente',a,mesKey,'meta_papel'));
  document.getElementById('tMetaExtraGer').innerHTML = metaExtraTable(gerRows, n=>({
    metaKg:metaExtraFor(d,'gerente',n,mesKey,'meta_kg'), realKg:realExtraFor(d,'gerente',n,mesKey,'rkg'),
    metaPapel:metaExtraFor(d,'gerente',n,mesKey,'meta_papel'), realPapel:realExtraFor(d,'gerente',n,mesKey,'rp'),
    metaEst:metaExtraFor(d,'gerente',n,mesKey,'meta_estrategico'), realEst:realExtraFor(d,'gerente',n,mesKey,'rest'),
  }), 'gerente');

  const effSupMeta = effectiveSupervisores(d);
  const supRowsAll = Object.keys(d.meta.por_supervisor).filter(n=>(!effSupMeta||effSupMeta.has(n))&&(!effGerMeta||effGerMeta.has(d.meta.por_supervisor[n].gerente)));
  const supRows = supRowsAll.filter(n=>!metaExtraFocus.ger || d.meta.por_supervisor[n].gerente===metaExtraFocus.ger).sort((a,b)=>metaExtraFor(d,'supervisor',b,mesKey,'meta_papel')-metaExtraFor(d,'supervisor',a,mesKey,'meta_papel'));
  document.getElementById('metaExtraSupSub').textContent = metaExtraFocus.ger ? `Supervisores de ${metaExtraFocus.ger}` : `${supRows.length} supervisores`;
  document.getElementById('tMetaExtraSup').innerHTML = metaExtraTable(supRows, n=>({
    metaKg:metaExtraFor(d,'supervisor',n,mesKey,'meta_kg'), realKg:realExtraFor(d,'supervisor',n,mesKey,'rkg'),
    metaPapel:metaExtraFor(d,'supervisor',n,mesKey,'meta_papel'), realPapel:realExtraFor(d,'supervisor',n,mesKey,'rp'),
    metaEst:metaExtraFor(d,'supervisor',n,mesKey,'meta_estrategico'), realEst:realExtraFor(d,'supervisor',n,mesKey,'rest'),
  }), 'supervisor');

  const vendRows = Object.keys(d.meta.por_vendedor).filter(n=>(ST.vend.length===0||ST.vend.includes(n))&&(!effSupMeta||effSupMeta.has(d.meta.por_vendedor[n].supervisor))).filter(n=>{
    if (metaExtraFocus.sup) return d.meta.por_vendedor[n].supervisor===metaExtraFocus.sup;
    if (metaExtraFocus.ger) return supRowsAll.filter(s=>d.meta.por_supervisor[s].gerente===metaExtraFocus.ger).includes(d.meta.por_vendedor[n].supervisor);
    return true;
  }).sort((a,b)=>metaExtraFor(d,'vendedor',b,mesKey,'meta_papel')-metaExtraFor(d,'vendedor',a,mesKey,'meta_papel'));
  document.getElementById('metaExtraVendSub').textContent = `${vendRows.length} vendedores com meta cadastrada no período` + (metaExtraFocus.sup?` — de ${metaExtraFocus.sup}`:metaExtraFocus.ger?` — de ${metaExtraFocus.ger}`:'');
  document.getElementById('tMetaExtraVend').innerHTML = metaExtraTable(vendRows, n=>({
    metaKg:metaExtraFor(d,'vendedor',n,mesKey,'meta_kg'), realKg:realExtraFor(d,'vendedor',n,mesKey,'rkg'),
    metaPapel:metaExtraFor(d,'vendedor',n,mesKey,'meta_papel'), realPapel:realExtraFor(d,'vendedor',n,mesKey,'rp'),
    metaEst:metaExtraFor(d,'vendedor',n,mesKey,'meta_estrategico'), realEst:realExtraFor(d,'vendedor',n,mesKey,'rest'),
  }));
}

// Agrega por_dia_categoria/por_dia (diário, ano completo do período) por mês —
// dateKey no formato yyyy-MM-dd.
function monthlyCategoriaAgg(period, mes){
  const out = {};
  if (!period || !period.por_dia_categoria) return out;
  const mesStr = String(mes).padStart(2,'0');
  Object.keys(period.por_dia_categoria).forEach(dateKey=>{
    if (dateKey.slice(5,7)!==mesStr) return;
    const catMap = period.por_dia_categoria[dateKey];
    Object.keys(catMap).forEach(cat=>{
      if (!out[cat]) out[cat] = {r:0,c:0};
      out[cat].r += catMap[cat][0]||0; out[cat].c += catMap[cat][1]||0;
    });
  });
  return out;
}
function monthlyGeralAgg(period, mes){
  const out = {r:0,c:0};
  if (!period || !period.por_dia) return out;
  const mesStr = String(mes).padStart(2,'0');
  Object.keys(period.por_dia).forEach(dateKey=>{
    if (dateKey.slice(5,7)!==mesStr) return;
    const v = period.por_dia[dateKey];
    out.r += v[0]||0; out.c += v[1]||0;
  });
  return out;
}
function monthYearFor(period, mes){
  const mesStr = String(mes).padStart(2,'0');
  const key = Object.keys((period&&period.por_dia)||{}).find(dk=>dk.slice(5,7)===mesStr);
  return key ? +key.slice(0,4) : null;
}
function businessDaysInMonth(year, month){
  let count=0; const daysInMonth = new Date(year, month, 0).getDate();
  for (let dnum=1; dnum<=daysInMonth; dnum++){ const dow = new Date(year, month-1, dnum).getDay(); if (dow>=1 && dow<=5) count++; }
  return count;
}
function businessDaysWithData(period, mes){
  if (!period || !period.por_dia) return 0;
  const mesStr = String(mes).padStart(2,'0');
  let count=0;
  Object.keys(period.por_dia).forEach(dateKey=>{
    if (dateKey.slice(5,7)!==mesStr) return;
    if (new Date(dateKey+"T00:00:00").getDay()>=1 && new Date(dateKey+"T00:00:00").getDay()<=5) count++;
  });
  return count;
}
// Tendência = projeção de fechamento do mês pelo ritmo diário observado até aqui.
// Em meses já fechados (todo dia útil tem dado), diasComDados=diasTotais => Tendência=Realizado.
function tendencia(realizado, period, mes){
  const year = monthYearFor(period, mes);
  if (!year) return realizado;
  const total = businessDaysInMonth(year, mes);
  const comDados = businessDaysWithData(period, mes);
  if (comDados<=0) return realizado;
  return realizado * (total/comDados);
}
// ── 3C. SAZONALIDADE — DIA ÚTIL / DIA DA SEMANA ─────────────────
// Análise à parte de Meta x Realizado: é sobre PADRÃO de vendas (data real do
// pedido), não sobre atingimento de meta — por isso ganhou aba própria.
// Cada dia agora guarda [receita,custo], então dá pra derivar Receita, Cash
// Margem (r-c) e Margem % (1-c/r) — todas com comparativo vs. mesma janela
// de 90 dias do ano anterior (mesmo período, PREV_OF).
// Sazonalidade só tem cubo hierárquico exato no nível Gerente (hier_por_dia*).
function diaHierAvailable(d){ return hierLevelActive()==='gerente' && !!(d.hier_por_dia && d.hier_por_dia.gerente); }
function mergeHierPorDia(d, names){
  const src = d.hier_por_dia && d.hier_por_dia.gerente;
  const merged = {};
  if (!src) return merged;
  names.forEach(n=>{
    const series = src[n]; if (!series) return;
    Object.keys(series).forEach(date=>{
      const v = series[date];
      if (!merged[date]) merged[date] = [0,0];
      merged[date][0]+=v[0]; merged[date][1]+=v[1];
    });
  });
  return merged;
}
function mergeHierPorDiaCategoria(d, names){
  const src = d.hier_por_dia_categoria && d.hier_por_dia_categoria.gerente;
  const merged = {};
  if (!src) return merged;
  names.forEach(n=>{
    const byDate = src[n]; if (!byDate) return;
    Object.keys(byDate).forEach(date=>{
      if (!merged[date]) merged[date] = {};
      const catMap = byDate[date];
      Object.keys(catMap).forEach(cat=>{
        const v = catMap[cat];
        if (!merged[date][cat]) merged[date][cat]=[0,0];
        merged[date][cat][0]+=v[0]; merged[date][cat][1]+=v[1];
      });
    });
  });
  return merged;
}
function diaFilterNote(hierOn){
  const blocked = (ST.sup.length||ST.vend.length) && !hierOn;
  if (hierOn) return `<div class="alert">Recortado por Gerente — <strong>${labelJoin(ST.ger)}</strong>: valores exatos (cubo hierárquico Gerente × Dia).</div>`;
  if (blocked) return `<div class="alert">⚠ Esta aba só é recortável por <strong>Gerente</strong> neste cubo — filtro de Supervisor/Vendedor/Cliente/Grupo ativo é ignorado aqui, mostrando o total da empresa. Categoria já é respeitada (linhas abaixo).</div>`;
  return "";
}

// ── SAZONALIDADE SEMANAL ─────────────────────────────────────────
// Agrega por SEMANA do calendário (segunda a domingo). Cada semana é
// identificada pela data da 2ª-feira (início da semana). A comparação com o ano
// anterior é feita alinhando semana-a-semana por ORDEM (1ª semana do período vs
// 1ª semana do período do ano anterior, 2ª vs 2ª, ...), já que as datas mudam
// de um ano para o outro. Fonte: por_dia (data real do pedido), 100% via API.
function fmtBR(iso){ const p = String(iso).split('-'); return p.length===3 ? `${p[2]}/${p[1]}` : iso; }
function isoMonday(dateStr){
  const d = new Date(dateStr+"T00:00:00");
  const dow = d.getDay();               // 0=Dom..6=Sáb
  const off = dow===0 ? 6 : dow-1;      // recua até a 2ª-feira
  d.setDate(d.getDate()-off);
  return d.toISOString().slice(0,10);
}
function emptyWeekSeries(){
  return { weeks:[], byMonday:{}, start:null, end:null, nWeeks:0,
    totalReceita:0, totalCash:0, mediaReceita:0, mediaCash:0, mediaMargem:0 };
}
// Agrupa {data:[r,c]} em semanas (chave = 2ª-feira). Retorna semanas ordenadas
// (com ordinal + monday + receita/cash/margem) e um índice byMonday p/ lookup.
function computeWeekSeries(porDia){
  if (!porDia) return null;
  const dates = Object.keys(porDia).sort();
  if (!dates.length) return null;
  const agg = {}; // monday -> {r,c}
  dates.forEach(dt=>{
    const v = porDia[dt];
    const r = v ? (v[0]||0) : 0, c = v ? (v[1]||0) : 0;
    const mon = isoMonday(dt);
    if (!agg[mon]) agg[mon] = { r:0, c:0 };
    agg[mon].r += r; agg[mon].c += c;
  });
  const mons = Object.keys(agg).sort();
  let totalR=0, totalC=0;
  const byMonday = {};
  const weeks = mons.map((mon,i)=>{
    const { r, c } = agg[mon]; totalR+=r; totalC+=c;
    const w = { ordinal:i+1, monday:mon,
      receita: round2c(r), cash: round2c(r-c), margem: r>0 ? round2c(100*(1-c/r)) : 0 };
    byMonday[mon] = w;
    return w;
  });
  const n = weeks.length;
  return {
    weeks, byMonday, start: mons[0], end: mons[mons.length-1], nWeeks: n,
    totalReceita: round2c(totalR), totalCash: round2c(totalR-totalC),
    mediaReceita: n>0 ? round2c(totalR/n) : 0,
    mediaCash: n>0 ? round2c((totalR-totalC)/n) : 0,
    mediaMargem: totalR>0 ? round2c(100*(1-totalC/totalR)) : 0,
  };
}
function renderDias(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const hierOn = diaHierAvailable(d);
  const porDiaBase = hierOn ? mergeHierPorDia(d, ST.ger) : d.por_dia;
  const porDiaCatBase = hierOn ? mergeHierPorDiaCategoria(d, ST.ger) : d.por_dia_categoria;
  document.getElementById('diasHierNote').innerHTML = diaFilterNote(hierOn);
  const geral = computeWeekSeries(porDiaBase);
  if (!geral){
    document.getElementById('diaSemanaSub').textContent = "Sem dados diários disponíveis para este período/recorte.";
    ['tDiaSemanaReceita','tDiaSemanaCash','tDiaSemanaMargem'].forEach(id=>document.getElementById(id).innerHTML="");
    if (charts["cDiaSemana"]) { charts["cDiaSemana"].destroy(); delete charts["cDiaSemana"]; }
    return;
  }
  const prevHierOn = hierOn && prev && prev.hier_por_dia && prev.hier_por_dia.gerente;
  const prevPorDiaBase = prevHierOn ? mergeHierPorDia(prev, ST.ger) : (prev ? prev.por_dia : null);
  const prevPorDiaCatBase = prevHierOn ? mergeHierPorDiaCategoria(prev, ST.ger) : (prev ? prev.por_dia_categoria : null);
  const prevGeral = prevPorDiaBase ? computeWeekSeries(prevPorDiaBase) : null;
  document.getElementById('diaSemanaSub').textContent =
    `${geral.nWeeks} semanas · ${fmtBR(geral.start)} a ${fmtBR(geral.end)}`
    + (prevGeral ? ` · comparado ao ano anterior (${prevGeral.nWeeks} semanas, alinhado por ordem da semana)` : ' · sem base do ano anterior para comparar');

  let catNames = d.meta && d.meta.por_categoria ? Object.keys(d.meta.por_categoria) : Object.keys(d.por_categoria);
  if (ST.cat.length) catNames = catNames.filter(c=>ST.cat.includes(c));
  const rows = [{ nome:"GERAL"+(ST.cat.length?" (categorias selecionadas)":" (todas as categorias)"), s:geral, sPrev:prevGeral }];
  catNames.forEach(cat=>{
    const s = computeWeekSeries(porDiaForCategoria(porDiaCatBase, cat));
    const sPrev = (prevGeral && prevPorDiaCatBase) ? computeWeekSeries(porDiaForCategoria(prevPorDiaCatBase, cat)) : null;
    rows.push({ nome:cat, s: s || emptyWeekSeries(), sPrev });
  });

  document.getElementById('tDiaSemanaReceita').innerHTML = buildWeekTable(rows, 'receita', false, geral, prevGeral);
  document.getElementById('tDiaSemanaCash').innerHTML = buildWeekTable(rows, 'cash', false, geral, prevGeral);
  document.getElementById('tDiaSemanaMargem').innerHTML = buildWeekTable(rows, 'margem', true, geral, prevGeral);

  const labels = geral.weeks.map(w=>"S"+w.ordinal);
  const datasets = [{ label:d.label, data:geral.weeks.map(w=>w.receita), backgroundColor:C.acc+"cc", borderRadius:4 }];
  if (prevGeral) datasets.push({ label:prev.label, type:'line',
    data:geral.weeks.map(w=>{ const pw = prevGeral.weeks[w.ordinal-1]; return pw ? pw.receita : null; }),
    borderColor:C.t2, borderDash:[4,4], backgroundColor:'transparent', tension:.3, pointRadius:2 });
  mkChart("cDiaSemana",{type:"bar",data:{labels,datasets},
    options:{responsive:true,plugins:{legend:{display:!!prevGeral,position:"top",labels:{boxWidth:10,font:{size:10}}},
      tooltip:{callbacks:{
        title:items=>{ const w=geral.weeks[items[0].dataIndex]; return `Semana ${w.ordinal} (início ${fmtBR(w.monday)})`; },
        label:c=>" "+(c.dataset.label||"")+": "+fF(c.raw) }}},
      scales:{y:{ticks:{callback:v=>fM(v)}}}}});
}
// metricKey: 'receita' | 'cash' (R$, delta relativo) | 'margem' (%, delta em p.p.)
// Alinhamento: colunas = semanas canônicas do período (série GERAL). Cada linha
// (categoria) busca seu valor pela DATA da 2ª-feira daquela semana. O comparativo
// com o ano anterior usa a semana de mesma ORDEM no período anterior.
function buildWeekTable(rows, metricKey, isPercent, geral, prevGeral){
  const fmt = v => isPercent ? fPct(v) : fF(v);
  const pill = (cur,prevv) => isPercent ? deltaPP(cur,prevv,false) : deltaPillSmall(cur,prevv);
  const cell = (cur,prevv) => `<div>${fmt(cur)}</div><div style="margin-top:2px">${pill(cur,prevv)}</div>`;
  const mediaKey = metricKey==='receita' ? 'mediaReceita' : metricKey==='cash' ? 'mediaCash' : 'mediaMargem';
  const weeks = geral.weeks;
  const head = `<thead><tr><th>Categoria</th><th class="tv">Média/semana</th>${
    weeks.map(w=>`<th class="tv" title="início ${fmtBR(w.monday)}">S${w.ordinal}</th>`).join("")}</tr></thead>`;
  const body = rows.map(r=>{
    const cur = r.s[mediaKey] || 0;
    const prevv = r.sPrev ? r.sPrev[mediaKey] : null;
    const weekCells = weeks.map((w,i)=>{
      const cw = r.s.byMonday ? r.s.byMonday[w.monday] : null;
      const cv = cw ? cw[metricKey] : 0;
      const prevMon = prevGeral && prevGeral.weeks[i] ? prevGeral.weeks[i].monday : null;
      const pw = (r.sPrev && r.sPrev.byMonday && prevMon) ? r.sPrev.byMonday[prevMon] : null;
      const pv = pw ? pw[metricKey] : (r.sPrev ? 0 : null);
      return `<td class="tv">${cell(cv,pv)}</td>`;
    }).join("");
    return `<tr><td class="tn">${r.nome}</td><td class="tv tn">${cell(cur,prevv)}</td>${weekCells}</tr>`;
  }).join("");
  return head + `<tbody>${body}</tbody>`;
}
// Reconstrói uma série {data: [r,c]} para UMA categoria a partir de por_dia_categoria
// (que é {data: {categoria: [r,c]}}) — usado para repetir a análise por categoria.
function porDiaForCategoria(porDiaCategoria, categoria){
  const out = {};
  Object.keys(porDiaCategoria||{}).forEach(date=>{
    const v = porDiaCategoria[date][categoria];
    if (v!=null) out[date] = v;
  });
  return out;
}


// ── 3D. MOTIVOS DA VARIAÇÃO POR DIA DA SEMANA ────────────────────
// Decomposição exata: para cada categoria, calcula sua contribuição MÉDIA num
// dia-da-semana específico vs. sua contribuição média num dia útil comum (mesma
// janela de 90 dias). A soma das contribuições de todas as categorias, num dado
// dia da semana, fecha exatamente com o desvio daquele dia vs. a média geral —
// é decomposição contábil (mix), não é modelo estatístico/causal.
const DOW_NAMES = {1:"Segunda",2:"Terça",3:"Quarta",4:"Quinta",5:"Sexta"};
function computeDayDrivers(porDia, porDiaCategoria, catNames, refEndStr){
  let endStr = refEndStr;
  if (!endStr){
    const dates = Object.keys(porDia||{}).sort();
    if (!dates.length) return null;
    endStr = dates[dates.length-1];
  }
  const end = new Date(endStr+"T00:00:00");
  if (isNaN(end.getTime())) return null;
  const start = new Date(end); start.setDate(start.getDate()-89);

  const catTotal = {}; const catByDow = {}; const dowCount = {1:0,2:0,3:0,4:0,5:0};
  catNames.forEach(cat=>{ catTotal[cat]={r:0,c:0}; catByDow[cat]={1:{r:0,c:0},2:{r:0,c:0},3:{r:0,c:0},4:{r:0,c:0},5:{r:0,c:0}}; });

  for (let d=new Date(start); d<=end; d.setDate(d.getDate()+1)){
    const dow = d.getDay();
    if (dow<1 || dow>5) continue;
    dowCount[dow]++;
    const key = d.toISOString().slice(0,10);
    const dayCatMap = (porDiaCategoria && porDiaCategoria[key]) || {};
    catNames.forEach(cat=>{
      const v = dayCatMap[cat];
      const r = v?(v[0]||0):0, c = v?(v[1]||0):0;
      catTotal[cat].r+=r; catTotal[cat].c+=c;
      catByDow[cat][dow].r+=r; catByDow[cat][dow].c+=c;
    });
  }
  const weekdayCount = Object.values(dowCount).reduce((a,b)=>a+b,0) || 1;

  const catAvg = {}; let totalAvgR=0, totalAvgC=0;
  catNames.forEach(cat=>{
    catAvg[cat] = { r: catTotal[cat].r/weekdayCount, c: catTotal[cat].c/weekdayCount };
    totalAvgR += catAvg[cat].r; totalAvgC += catAvg[cat].c;
  });

  const results = [];
  for (let dow=1; dow<=5; dow++){
    const n = dowCount[dow] || 1;
    let dayR=0, dayC=0;
    const catDow = {};
    catNames.forEach(cat=>{
      const rr = catByDow[cat][dow].r/n, cc = catByDow[cat][dow].c/n;
      catDow[cat] = {r:rr,c:cc};
      dayR+=rr; dayC+=cc;
    });
    catNames.forEach(cat=>{
      const contribFat = catDow[cat].r - catAvg[cat].r;
      const contribCash = (catDow[cat].r-catDow[cat].c) - (catAvg[cat].r-catAvg[cat].c);
      const shareDow = dayR>0 ? catDow[cat].r/dayR : 0;
      const shareAvg = totalAvgR>0 ? catAvg[cat].r/totalAvgR : 0;
      const margCatDow = catDow[cat].r>0 ? 1-catDow[cat].c/catDow[cat].r : 0;
      const margCatAvg = catAvg[cat].r>0 ? 1-catAvg[cat].c/catAvg[cat].r : 0;
      const contribMargem = (shareDow*margCatDow - shareAvg*margCatAvg)*100;
      results.push({ cat, dow, dowNome:DOW_NAMES[dow], contribFat, contribCash, contribMargem });
    });
  }
  return { results, start:start.toISOString().slice(0,10), end:endStr, weekdayCount };
}
function findDriver(driverResult, cat, dow){
  if (!driverResult) return null;
  return driverResult.results.find(x=>x.cat===cat && x.dow===dow) || null;
}
function renderMotivos(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const hierOn = diaHierAvailable(d);
  document.getElementById('motivosHierNote').innerHTML = diaFilterNote(hierOn);
  const porDiaBase = hierOn ? mergeHierPorDia(d, ST.ger) : d.por_dia;
  const porDiaCatBase = hierOn ? mergeHierPorDiaCategoria(d, ST.ger) : d.por_dia_categoria;
  let catNames = d.meta && d.meta.por_categoria ? Object.keys(d.meta.por_categoria) : Object.keys(d.por_categoria);
  if (ST.cat.length) catNames = catNames.filter(c=>ST.cat.includes(c));
  const drv = computeDayDrivers(porDiaBase, porDiaCatBase, catNames);
  if (!drv || catNames.length===0){
    document.getElementById('motivosSub').textContent = "Sem dados diários disponíveis para este período/recorte.";
    ['tMotivosFat','tMotivosCash','tMotivosMargem'].forEach(id=>document.getElementById(id).innerHTML="");
    return;
  }
  const prevHierOn = hierOn && prev && prev.hier_por_dia && prev.hier_por_dia.gerente;
  const prevPorDiaBase = prevHierOn ? mergeHierPorDia(prev, ST.ger) : (prev ? prev.por_dia : null);
  const prevPorDiaCatBase = prevHierOn ? mergeHierPorDiaCategoria(prev, ST.ger) : (prev ? prev.por_dia_categoria : null);
  const drvPrev = prevPorDiaBase ? computeDayDrivers(prevPorDiaBase, prevPorDiaCatBase, catNames) : null;
  document.getElementById('motivosSub').textContent = `Janela: ${drv.start} a ${drv.end} (${drv.weekdayCount} dias úteis)` + (drvPrev?` · comparado a ${drvPrev.start} a ${drvPrev.end} do ano anterior`:' · sem base do ano anterior para este período');

  function buildTable(metricKey, isPercent){
    const top5 = [...drv.results].sort((a,b)=>Math.abs(b[metricKey])-Math.abs(a[metricKey])).slice(0,5);
    const fmt = v => isPercent ? (v>=0?'+':'')+v.toFixed(2)+' p.p.' : (v>=0?'▲ ':'▼ ')+fF(Math.abs(v));
    return `<thead><tr><th>#</th><th>Categoria</th><th>Dia</th><th class="tv">Contribuição</th><th class="tv">Mesmo par — ano anterior</th></tr></thead><tbody>${
      top5.map((r,i)=>{
        const prevDriver = drvPrev ? findDriver(drvPrev, r.cat, r.dow) : null;
        const prevVal = prevDriver ? prevDriver[metricKey] : null;
        const cls = r[metricKey]>=0 ? 'up' : 'dn';
        return `<tr><td><span class="badge-rk ${i===0?'g1':i===1?'g2':i===2?'g3':''}">${i+1}</span></td><td class="tn">${r.cat}</td><td>${r.dowNome}</td><td class="tv"><span class="delta-pill ${cls}">${fmt(r[metricKey])}</span></td><td class="tv">${prevVal!=null?fmt(prevVal):'<span style="color:var(--t3)">sem base</span>'}</td></tr>`;
      }).join("")}</tbody>`;
  }
  document.getElementById('tMotivosFat').innerHTML = buildTable('contribFat', false);
  document.getElementById('tMotivosCash').innerHTML = buildTable('contribCash', false);
  document.getElementById('tMotivosMargem').innerHTML = buildTable('contribMargem', true);
}

// ── 6B. PLANOS DE AÇÃO POR CATEGORIA (formato executivo/diretoria) ──
// Cada categoria = 1 "memo" de diretoria com 3 partes (Panorama, Diagnóstico,
// Proposta). Todo número citado vem direto da base — nada aqui é redigido
// livremente, é template determinístico sobre os agregados já calculados.
function renderPlanos(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const level = hierLevelActive();
  document.getElementById('planosHierNote').innerHTML = level
    ? `<div class="alert">⚠ Os planos abaixo usam os números da <strong>empresa inteira</strong> — esta aba não é recortável por Gerente/Supervisor/Vendedor neste cubo (receita/margem por categoria seriam exatos, mas positivação e produto líder por categoria só existem no nível empresa). Filtro de Categoria já é respeitado (mostrando só as categorias selecionadas).</div>` : "";
  let cats = Object.keys(d.por_categoria).sort((a,b)=>d.por_categoria[b].r-d.por_categoria[a].r);
  if (ST.cat.length) cats = cats.filter(c=>ST.cat.includes(c));
  const drv = computeDayDrivers(d.por_dia, d.por_dia_categoria, cats);
  document.getElementById('planos-cards').innerHTML = cats.map((cat,i)=>buildExecPlan(cat, i, cats.length, d, prev, drv)).join("");
}

function buildExecPlan(cat, idx, totalCats, d, prev, drv){
  const v = d.por_categoria[cat];
  const pv = (prev && prev.por_categoria[cat]) ? prev.por_categoria[cat] : null;
  const metaVal = (d.meta && d.meta.por_categoria) ? d.meta.por_categoria[cat] : null;
  const ating = (metaVal && metaVal>0) ? v.r/metaVal*100 : null;
  const share = d.receita>0 ? v.r/d.receita*100 : 0;
  const pos = d.n_cli>0 ? v.n_clientes/d.n_cli*100 : 0;
  const posPrev = (pv && prev.n_cli>0) ? pv.n_clientes/prev.n_cli*100 : null;
  const deltaReceita = (pv && pv.r>0) ? (v.r-pv.r)/pv.r*100 : null;
  const deltaMargem = pv ? v.m-pv.m : null;
  const deltaPos = posPrev!=null ? pos-posPrev : null;
  const gapMargem = v.m - d.margem_geral;
  const cashMargem = v.r - v.c;
  const topsCategoria = d.top_produtos.filter(p=>p.categoria===cat);
  const top1 = topsCategoria[0] || null;
  const concTop1 = (top1 && v.r>0) ? top1.r/v.r*100 : null;
  const ticketMedioCliente = v.n_clientes>0 ? v.r/v.n_clientes : 0;
  const ganhoPosReceita = 0.05 * d.n_cli * ticketMedioCliente;
  const ganhoMargemCash = v.r * 0.01;

  let driverTxt = null;
  if (drv){
    const own = drv.results.filter(x=>x.cat===cat);
    if (own.length){
      const maxFat = own.reduce((a,b)=>Math.abs(b.contribFat)>Math.abs(a.contribFat)?b:a);
      if (Math.abs(maxFat.contribFat) > 1){
        driverTxt = `Na aba "Motivos da Variação", esta categoria é driver relevante de faturamento na <strong>${maxFat.dowNome}-feira</strong> (${maxFat.contribFat>=0?'+':''}${fF(maxFat.contribFat)} vs. a média de um dia útil comum).`;
      }
    }
  }

  // ── 1. Visão Geral (Panorama Executivo) ──
  const situacaoAtual = `<strong>${cat}</strong> responde por <strong>${share.toFixed(1)}%</strong> da receita total do período (${fF(v.r)}), com margem de <strong>${fPct(v.m)}</strong> (${gapMargem>=0?'+':''}${gapMargem.toFixed(1)} p.p. vs. a média da empresa) e cash margem de <strong>${fF(cashMargem)}</strong>. Positivação atual: <strong>${pos.toFixed(1)}%</strong> da base ativa (${fN(v.n_clientes)} de ${fN(d.n_cli)} clientes).`;
  const direcionadores = ating!=null
    ? `Atingimento de meta no período: <strong>${ating.toFixed(1)}%</strong> (meta ${fF(metaVal)} vs. realizado ${fF(v.r)}) — categoria <strong>${ating>=100?'acima':'abaixo'}</strong> do direcionador orçamentário aprovado pela diretoria.`
    : `Sem meta cadastrada para esta categoria no período — recomenda-se formalizar um direcionador orçamentário específico no próximo ciclo de planejamento.`;
  const impactoEsperado = `Cenário ilustrativo com base no ticket médio atual da categoria (${fF(ticketMedioCliente)}/cliente/período) — não é meta formal, é referência de ordem de grandeza: elevar a positivação em 5 p.p. representa um potencial incremental de receita de aproximadamente <strong>${fF(ganhoPosReceita)}</strong>; um ganho de 1 p.p. de margem equivale a <strong>${fF(ganhoMargemCash)}</strong> adicionais de cash margem sem qualquer volume extra.`;

  // ── 2. Análise Estruturada e Insights ──
  const diagnostico = [
    deltaReceita!=null ? `Receita ${deltaReceita>=0?'cresceu':'caiu'} <strong>${Math.abs(deltaReceita).toFixed(1)}%</strong> vs. o mesmo período do ano anterior (${fF(pv.r)} → ${fF(v.r)}).` : `Sem base do ano anterior para esta categoria.`,
    deltaMargem!=null ? `Margem ${deltaMargem>=0?'melhorou':'piorou'} <strong>${Math.abs(deltaMargem).toFixed(1)} p.p.</strong> no mesmo comparativo.` : null,
    deltaPos!=null ? `Positivação ${deltaPos>=0?'subiu':'caiu'} <strong>${Math.abs(deltaPos).toFixed(1)} p.p.</strong>.` : null,
    driverTxt,
  ].filter(Boolean).join(' ');

  const insights = [
    `Rank de receita entre as categorias: <strong>${idx+1}ª de ${totalCats}</strong>.`,
    top1 ? `Produto líder: <strong>${top1.nome}</strong>, responsável por <strong>${concTop1.toFixed(1)}%</strong> da receita da categoria (${fF(top1.r)}).` : `Sem produto identificado como líder claro da categoria.`,
    `Cash margem no período: <strong>${fF(cashMargem)}</strong> — ${(cashMargem/(d.receita-d.custo)*100).toFixed(1)}% da cash margem total da empresa.`,
  ];

  const riscos = [];
  if (concTop1!=null && concTop1>=50) riscos.push({tit:"Concentração de produto", txt:`${concTop1.toFixed(1)}% da receita da categoria depende de um único item (${top1.nome}). Mitigador: diversificar o portfólio ativo e monitorar risco de ruptura de fornecimento deste SKU.`});
  if (gapMargem<0) riscos.push({tit:"Margem abaixo da média da empresa", txt:`Margem ${Math.abs(gapMargem).toFixed(1)} p.p. abaixo da média (${fPct(d.margem_geral)}). Mitigador: revisar política de desconto e cruzar com os piores clientes em margem (aba Rankings) antes de renovar condições comerciais.`});
  if (pos<50) riscos.push({tit:"Baixa positivação", txt:`Apenas ${pos.toFixed(1)}% da base ativa compra esta categoria — dependência de poucos clientes. Mitigador: plano de cross-sell dirigido (ver Pilares da Solução).`});
  if (deltaReceita!=null && deltaReceita<-5) riscos.push({tit:"Retração de receita", txt:`Queda de ${Math.abs(deltaReceita).toFixed(1)}% vs. ano anterior. Mitigador: diagnóstico comercial por território (Gerente/Supervisor) para isolar onde a queda se concentra antes de agir.`});
  if (!riscos.length) riscos.push({tit:"Nenhum risco crítico identificado", txt:"Nos indicadores disponíveis (margem, positivação, tendência de receita), esta categoria não apresenta sinal de alerta no período — manter monitoramento de rotina."});

  // ── 3. Proposta / Solução ──
  const objetivoCentral = `Elevar a contribuição de ${cat} para o resultado da empresa por três frentes simultâneas: crescer receita sem abrir mão de margem, e ampliar o alcance da categoria na base de clientes ativos.`;

  const pilares = [
    { tit:"Crescimento de receita", txt: (deltaReceita!=null && deltaReceita<0) ? `Recuperar a queda de ${Math.abs(deltaReceita).toFixed(1)}% vs. ano anterior, priorizando os territórios com maior retração.` : `Sustentar o crescimento (${deltaReceita!=null?'+'+deltaReceita.toFixed(1)+'%':'atual'}) replicando a abordagem comercial nos territórios com menor participação desta categoria.` },
    { tit:"Proteção/expansão de margem", txt: gapMargem<0 ? `Elevar a margem — hoje ${Math.abs(gapMargem).toFixed(1)} p.p. abaixo da média — via revisão de política de desconto.` : `Manter a disciplina de precificação que sustenta a margem ${gapMargem.toFixed(1)} p.p. acima da média da empresa.` },
    { tit:"Expansão de positivação", txt: `Elevar a positivação (hoje ${pos.toFixed(1)}%) via cross-sell dirigido aos clientes ativos que compram categorias correlatas mas não esta.` },
    { tit:"Redução de concentração", txt: concTop1!=null ? `Diversificar o portfólio ativo — hoje ${concTop1.toFixed(1)}% da receita da categoria está em um único produto.` : `Ampliar o mix de produtos ativos dentro da categoria.` },
    { tit:"Governança de acompanhamento", txt: ating!=null ? `Revisar mensalmente o atingimento de meta (hoje ${ating.toFixed(1)}%) nos fóruns de gestão comercial.` : `Formalizar meta específica para esta categoria no próximo ciclo de planejamento.` },
  ];

  const beneficiosTangiveis = [
    `Potencial de receita incremental: <strong>${fF(ganhoPosReceita)}</strong> (cenário +5 p.p. de positivação)`,
    `Potencial de cash margem incremental: <strong>${fF(ganhoMargemCash)}</strong> (cenário +1 p.p. de margem)`,
    `Cash margem atual protegida: <strong>${fF(cashMargem)}</strong>`,
  ];
  const beneficiosIntangiveis = [
    "Governança comercial mais previsível, com menos exceções de desconto fora de política.",
    concTop1!=null && concTop1>=50 ? "Maior resiliência de portfólio — menor exposição a ruptura de um único fornecedor/SKU." : "Portfólio já diversificado — risco de concentração de produto sob controle.",
    "Relacionamento mais amplo com a base de clientes — cross-sell reduz o risco de perda total de conta.",
  ];

  const kpiSummary = `Receita <b>${fF(v.r)}</b> · Margem <b>${fPct(v.m)}</b> · Positivação <b>${pos.toFixed(1)}%</b>`;

  return `<details class="exec-details"${idx===0?' open':''}>
    <summary class="exec-summary">
      <span class="exec-summary-title"><span class="exec-rank">${idx+1}</span>${cat}</span>
      <span class="exec-summary-kpis">${kpiSummary}</span>
    </summary>
    <div class="exec-body">
      <div class="exec-part">
        <div class="exec-part-title"><span class="exec-part-num">1</span>Visão Geral — Panorama Executivo</div>
        <div class="exec-sec"><div class="exec-item-lbl">Situação atual</div><div class="exec-item-body">${situacaoAtual}</div></div>
        <div class="exec-sec"><div class="exec-item-lbl">Direcionadores estratégicos</div><div class="exec-item-body">${direcionadores}</div></div>
        <div class="exec-sec"><div class="exec-item-lbl">Impacto esperado</div><div class="exec-item-body">${impactoEsperado}</div></div>
      </div>
      <div class="exec-part">
        <div class="exec-part-title"><span class="exec-part-num">2</span>Análise Estruturada e Insights</div>
        <div class="exec-sec"><div class="exec-item-lbl">Diagnóstico</div><div class="exec-item-body">${diagnostico}</div></div>
        <div class="exec-sec"><div class="exec-item-lbl">Principais insights</div><div class="exec-item-body"><ul class="exec-benefit-list">${insights.map(x=>`<li>${x}</li>`).join("")}</ul></div></div>
        <div class="exec-sec"><div class="exec-item-lbl">Riscos e mitigadores</div>${riscos.map(r=>`<div class="exec-risk"><div class="exec-risk-tit">${r.tit}</div><div class="exec-risk-txt">${r.txt}</div></div>`).join("")}</div>
      </div>
      <div class="exec-part">
        <div class="exec-part-title"><span class="exec-part-num">3</span>Proposta / Solução</div>
        <div class="exec-sec"><div class="exec-item-lbl">Objetivo central da proposta</div><div class="exec-item-body">${objetivoCentral}</div></div>
        <div class="exec-sec"><div class="exec-item-lbl">Pilares da solução</div><div class="exec-pillars">${pilares.map(p=>`<div class="exec-pillar"><div class="exec-pillar-tit">${p.tit}</div><div class="exec-pillar-txt">${p.txt}</div></div>`).join("")}</div></div>
        <div class="exec-sec"><div class="exec-benefits">
          <div><div class="exec-item-lbl">Benefícios tangíveis</div><ul class="exec-benefit-list">${beneficiosTangiveis.map(x=>`<li>${x}</li>`).join("")}</ul></div>
          <div><div class="exec-item-lbl">Benefícios intangíveis</div><ul class="exec-benefit-list">${beneficiosIntangiveis.map(x=>`<li>${x}</li>`).join("")}</ul></div>
        </div></div>
      </div>
    </div>
  </details>`;
}

// ── 4. RANKINGS ───────────────────────────────────────────────
function renderRank(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];

  // Com filtro de Gerente/Supervisor/Vendedor ativo, usa o cubo hierárquico (Top 50
  // por entidade, dados reais) em vez do Top 50 global — assim a tabela reflete quem
  // está selecionado, não a empresa inteira.
  const cliBase  = topClientesFonte(d, level, names);
  const prodBase = topProdutosFonte(d, level, names);
  document.getElementById("rankHierNote").innerHTML = level
    ? `<div class="alert">Recortado por ${level} — <strong>${labelJoin(names)}</strong>: listas calculadas a partir do Top 50 real de cada entidade (cubo hierárquico), não do Top 50 da empresa inteira.</div>` : "";

  const cli = filtrarClientes(cliBase).slice(0,50);
  document.getElementById("tTopCli").innerHTML = tblRank(cli,"nome",
    r=>prevLookupList(prev,"top_clientes","nome",r.nome), r=>prevLookupListMargin(prev,"top_clientes","nome",r.nome));

  const prod = prodBase.filter(p=>ST.cat.length===0||ST.cat.includes(p.categoria)).slice(0,50);
  document.getElementById("tTopProd").innerHTML = tblRank(prod,"nome",
    r=>prevLookupList(prev,"top_produtos","nome",r.nome), r=>prevLookupListMargin(prev,"top_produtos","nome",r.nome));

  const vend = d.top_vendedores.filter(v=>(ST.sup.length===0||ST.sup.includes(v.supervisor))&&(ST.vend.length===0||ST.vend.includes(v.nome))).slice(0,50);
  document.getElementById("tTopVend").innerHTML = tblRank(vend,"nome",
    r=>prevLookupList(prev,"top_vendedores","nome",r.nome), r=>prevLookupListMargin(prev,"top_vendedores","nome",r.nome));

  const base = filtrarClientes(cliBase);
  const ofensores = [...base].sort((a,b)=>a.m-b.m).slice(0,50);
  document.getElementById("tOfensores").innerHTML = tblRank(ofensores,"nome",
    r=>prevLookupList(prev,"top_clientes","nome",r.nome), r=>prevLookupListMargin(prev,"top_clientes","nome",r.nome));
}
// prevFn/prevMarginFn: opcionais — recebem a linha e retornam a receita/margem do
// mesmo item no período anterior (null se o item não estava no Top-N daquele período).
function tblRank(rows,nameKey,prevFn,prevMarginFn){
  return `<thead><tr><th>#</th><th>Nome</th><th class="tv">Receita</th><th class="tv">Δ vs ano ant.</th><th class="tv">Cash Margem</th><th class="tv">Margem %</th><th class="tv">Δ Margem (ano ant.)</th></tr></thead><tbody>${
    rows.map((r,i)=>`<tr><td><span class="badge-rk ${i===0?'g1':i===1?'g2':i===2?'g3':''}">${i+1}</span></td><td class="tn">${r[nameKey]}</td><td class="tv">${fF(r.r)}</td><td class="tv">${deltaPillSmall(r.r, prevFn?prevFn(r):null)}</td><td class="tv">${fF(r.r-r.c)}</td><td class="tv">${margemBadge(r.m)}</td><td class="tv">${deltaPP(r.m, prevMarginFn?prevMarginFn(r):null, false)}</td></tr>`).join("")}</tbody>`;
}

// ── 5. MIX & POSITIVAÇÃO ──────────────────────────────────────
function renderMix(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const nMeses = Object.keys(d.por_mes).length;
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  const base = topClientesFonte(d, level, names);
  document.getElementById("mixHierNote").innerHTML = level
    ? `<div class="alert">Recortado por ${level} — <strong>${labelJoin(names)}</strong>: Top 50 real de cada entidade. "Categorias distintas"/"Meses ativos" continuam refletindo o comportamento total do cliente (com todos os vendedores), não só este recorte.</div>` : "";
  const rows = filtrarClientes(base).slice(0,25);
  document.getElementById("tMix").innerHTML = `<thead><tr><th>Cliente</th><th class="tv">Receita</th><th class="tv">Δ vs ano ant.</th><th class="tv">Categorias distintas</th><th class="tv">Meses ativos</th><th class="tv">Positivação</th></tr></thead><tbody>${
    rows.map(r=>{
      const pos = Math.round(r.meses_ativos/nMeses*100);
      const pv = prevLookupList(prev,"top_clientes","nome",r.nome);
      return `<tr><td class="tn">${r.nome}</td><td class="tv">${fF(r.r)}</td><td class="tv">${deltaPillSmall(r.r,pv)}</td><td class="tv">${r.categorias} de ${d.n_cat}</td><td class="tv">${r.meses_ativos} de ${nMeses}</td>
        <td class="tv"><div class="bar-row"><div class="bar-bg"><div class="bar-fg" style="width:${pos}%"></div></div><div class="bar-pct">${pos}%</div></div></td></tr>`;
    }).join("")}</tbody>`;
}

// ── 6. ABCD ───────────────────────────────────────────────────
// ── Drill-down Cliente x Categoria (clicar num cliente das Classes A/B/C/D) ──
// d.cliente_categoria[codigo][categoria] = [r,c] — só existe para os ~200
// clientes que aparecem nos Exemplos ABCD (ver run_etl.ps1), para manter o
// JSON pequeno. Comparativo usa o mesmo código de cliente no período anterior
// (PREV_OF) — códigos de cliente são estáveis entre semestres.
let abcdExpandedClients = new Set();
function toggleAbcdClient(key){
  if (abcdExpandedClients.has(key)) abcdExpandedClients.delete(key); else abcdExpandedClients.add(key);
  renderAbcd();
}
function clienteCategoriaRows(codigo){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const catMap = (d.cliente_categoria && d.cliente_categoria[codigo]) || null;
  if (!catMap){
    return `<tr><td colspan="5" style="padding-left:24px;color:var(--t3);font-style:italic">Sem detalhamento por categoria disponível para este cliente neste recorte.</td></tr>`;
  }
  const prevCatMap = (prev && prev.cliente_categoria && prev.cliente_categoria[codigo]) || null;
  const catNames = Object.keys(catMap).sort((a,b)=>catMap[b][0]-catMap[a][0]);
  return catNames.map(cat=>{
    const r=catMap[cat][0], c=catMap[cat][1];
    const m = r>0 ? +(100*(1-c/r)).toFixed(2) : 0;
    const cash = r-c;
    const pv = prevCatMap ? prevCatMap[cat] : null;
    const pr = pv?pv[0]:null, pc = pv?pv[1]:null;
    const pm = (pv && pr>0) ? +(100*(1-pc/pr)).toFixed(2) : null;
    const pcash = pv ? (pr-pc) : null;
    return `<tr class="casc-lvl1"><td style="padding-left:24px;color:var(--t2);font-style:italic">${escAttr(cat)}</td>
      <td class="tv">${fF(r)}<div>${deltaPillSmall(r,pr)}</div></td>
      <td class="tv">${fF(cash)}<div>${deltaPillSmall(cash,pcash)}</div></td>
      <td class="tv">${margemBadge(m)}</td>
      <td class="tv">${pm!=null?deltaPP(m,pm,false):'<span style="color:var(--t3)">sem base</span>'}</td></tr>`;
  }).join("") || `<tr><td colspan="5" style="padding-left:24px;color:var(--t3);font-style:italic">Sem valor de venda em nenhuma categoria neste recorte.</td></tr>`;
}
function renderAbcd(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  // Com filtro de hierarquia ativo, reclassifica usando a MESMA mediana global (mais
  // específico não deveria ter um "corte" diferente — senão a classe A de um vendedor
  // pequeno deixaria de ser comparável com a de outro). Só os totais são recortados.
  const a = level ? hierUnionAbcd(level, names) : d.abcd;
  const totalReceita = level ? (a.A.receita+a.B.receita+a.C.receita+a.D.receita) : d.receita;
  const prevA = level ? (prev ? hierUnionAbcdFor(prev, level, names) : null) : prev && prev.abcd;

  document.getElementById("abcd-sub").textContent = level
    ? `Recortado por ${level}: ${labelJoin(names)} · classificado pela mediana GLOBAL do período (receita ${fF(d.abcd.mediana_receita)} · margem ${fPct(d.abcd.mediana_margem)})`
    : `Mediana de receita: ${fF(a.mediana_receita)} · Mediana de margem: ${fPct(a.mediana_margem)} · Base: ${fN(a.n_clientes_considerados)} clientes com receita > 0`;
  const defs = [
    {k:"A",cls:"abcd-a",title:"Alta venda + Alta margem",desc:"Clientes-âncora. Proteger relacionamento e nível de serviço."},
    {k:"B",cls:"abcd-b",title:"Alta venda + Baixa margem",desc:"Revisar política comercial/desconto — volume não compensa margem."},
    {k:"C",cls:"abcd-c",title:"Baixa venda + Alta margem",desc:"Potencial de crescimento — bom mix, falta volume. Foco em cross/up-sell."},
    {k:"D",cls:"abcd-d",title:"Baixa venda + Baixa margem",desc:"Reavaliar custo de atendimento; candidatos a racionalização."},
  ];
  document.getElementById("abcd-boxes").innerHTML = defs.map(x=>{
    const q = a[x.k];
    const pct = totalReceita>0 ? (q.receita/totalReceita*100).toFixed(1) : "0";
    const pv = prevA ? prevA[x.k] : null;
    const cm = q.cash_margin!=null ? q.cash_margin : null;
    const deltaHtml = `<div style="margin-top:8px;display:flex;gap:5px;justify-content:center;flex-wrap:wrap">${deltaPillSmall(q.receita, pv?pv.receita:null)}<span style="font-size:9px;color:var(--t3)">receita</span> ${deltaPillSmall(q.count, pv?pv.count:null)}<span style="font-size:9px;color:var(--t3)">clientes</span></div>`;
    const cashLine = cm!=null ? `<br>Cash Margem: <strong>${fF(cm)}</strong>` : "";
    return `<div class="abcd-box ${x.cls}"><div class="abcd-letter">${x.k}</div><div class="abcd-title">${x.title}</div>
      <div class="abcd-desc">${fN(q.count)} clientes<br>${fF(q.receita)} (${pct}% da receita)${cashLine}<br>${x.desc}</div>${deltaHtml}</div>`;
  }).join("");

  // Exemplos por classe: no recorte hierárquico, usa o Top 50 daquela entidade (já
  // ordenado por receita) filtrando por classe via reclassificação client a client.
  const exemplosPorClasse = level ? hierExemplos(level, names, d.abcd.mediana_receita, d.abcd.mediana_margem) : null;
  document.getElementById("abcd-examples").innerHTML = defs.map(x=>{
    const q = a[x.k];
    const exemplos = level ? (exemplosPorClasse[x.k]||[]) : q.exemplos;
    return `<div class="card"><div class="card-h"><div class="card-title">Exemplos — Classe ${x.k}</div><div class="card-sub">Clique no cliente para ver o detalhamento por categoria</div></div><div class="tbl-wrap"><table>
      <thead><tr><th>Cliente</th><th class="tv">Receita</th><th class="tv">Cash Margem</th><th class="tv">Margem</th><th class="tv">Δ Margem (ano ant.)</th></tr></thead>
      <tbody>${exemplos.length?exemplos.map(e=>{
        const pvM = prevLookupListMargin(prev,"top_clientes","nome",e.nome);
        const cm = e.cash_margin!=null ? e.cash_margin : (e.c!=null ? e.r-e.c : null);
        const key = x.k+'|||'+e.codigo;
        const expanded = abcdExpandedClients.has(key);
        const toggle = `<span class="casc-toggle" onclick="toggleAbcdClient('${key}')">${expanded?'−':'+'}</span>`;
        const mainRow = `<tr><td class="tn">${toggle}${e.nome}</td><td class="tv">${fF(e.r)}</td><td class="tv">${cm!=null?fF(cm):'—'}</td><td class="tv">${margemBadge(e.m)}</td><td class="tv">${deltaPP(e.m,pvM,false)}</td></tr>`;
        return mainRow + (expanded ? clienteCategoriaRows(e.codigo) : '');
      }).join(""):'<tr><td colspan="5" style="color:var(--t3)">Nenhum exemplo no Top 50 desta entidade cai nesta classe</td></tr>'}</tbody>
      </table></div></div>`;
  }).join("");
}
function hierUnionAbcdFor(period, level, names){
  const q = {A:{count:0,receita:0,custo:0},B:{count:0,receita:0,custo:0},C:{count:0,receita:0,custo:0},D:{count:0,receita:0,custo:0}};
  names.forEach(n=>{
    const a = period.hier_abcd && period.hier_abcd[level] && period.hier_abcd[level][n];
    if (!a) return;
    ['A','B','C','D'].forEach(k=>{ q[k].count+=a[k].count; q[k].receita+=a[k].receita; q[k].custo+=(a[k].custo||0); });
  });
  ['A','B','C','D'].forEach(k=>{ q[k].cash_margin = q[k].receita - q[k].custo; });
  return q;
}
function hierExemplos(level, names, medR, medM){
  const clientes = topClientesFonte(curPeriod(), level, names);
  const out = {A:[],B:[],C:[],D:[]};
  clientes.forEach(c=>{
    if (c.r<=0) return;
    const k = (c.r>=medR && c.m>=medM) ? 'A' : (c.r>=medR) ? 'B' : (c.m>=medM) ? 'C' : 'D';
    if (out[k].length<50) out[k].push(c);
  });
  return out;
}

// ── 6C. ESTOQUE X VENDA — COBERTURA EM DIAS ──────────────────────
// Estoque ("Base Estoque Box Vendedor", coluna saldo) é uma FOTO atual, sem
// recorte de período. A venda média/dia usa a mesma janela fixa de 90 dias do
// período selecionado (por_produto_janela90, já usada em Sazonalidade/Motivos).
// DOS agregado (Gerente/Supervisor/Vendedor/Categoria) agrupa por PRODUTO
// primeiro para não contar a mesma taxa de venda do produto mais de uma vez
// só porque vários vendedores carregam o mesmo item.
function computeEstoqueDOS(rows, p90, windowDays){
  const byProduto = {};
  rows.forEach(r=>{
    if (!byProduto[r.codproduto]) byProduto[r.codproduto] = {valor:0, saldo:0};
    byProduto[r.codproduto].valor += r.valor_carga;
    byProduto[r.codproduto].saldo += r.saldo;
  });
  let valorTotal=0, saldoTotal=0, avgDailyValor=0;
  const codes = Object.keys(byProduto);
  codes.forEach(cod=>{
    valorTotal += byProduto[cod].valor; saldoTotal += byProduto[cod].saldo;
    const v90 = p90[cod];
    avgDailyValor += v90 ? v90.r/windowDays : 0;
  });
  return { valorTotal, saldoTotal, avgDailyValor, dos: avgDailyValor>0 ? valorTotal/avgDailyValor : null, nProdutos: codes.length };
}
// est.detalhe vem compacto — [codven, codproduto, saldo, valor_carga] — para não
// repetir nome de vendedor/supervisor/gerente e descrição/categoria/grupo do
// produto em ~44 mil linhas. "Hidrata" via os lookups vendedor_info/por_produto.
function estoqueHydrate(est, tuple){
  const codven=tuple[0], codproduto=tuple[1], saldo=tuple[2], valor_carga=tuple[3];
  const vi = est.vendedor_info[codven] || {vendedor:"(desconhecido)", supervisor:"(desconhecido)", gerente:"(desconhecido)"};
  const pi = est.por_produto[codproduto] || {descricao:codproduto, categoria:"(sem categoria)", grupo:""};
  return { codven, codproduto, saldo, valor_carga, vendedor:vi.vendedor, supervisor:vi.supervisor, gerente:vi.gerente, descricao:pi.descricao, categoria:pi.categoria, grupo:pi.grupo };
}
// O estoque é uma fotografia por vendedor×produto (não tem cliente), então respeita
// hierarquia + produto. Canal/Inadimplente/Status são atributos do CLIENTE e não se
// aplicam aqui.
function estoqueFilterRows(est){
  return est.detalhe.map(t=>estoqueHydrate(est,t)).filter(r=>
    (ST.ger.length===0||ST.ger.includes(r.gerente)) &&
    (ST.sup.length===0||ST.sup.includes(r.supervisor)) &&
    (ST.vend.length===0||ST.vend.includes(r.vendedor)) &&
    (ST.cat.length===0||ST.cat.includes(r.categoria)) &&
    (ST.grp.length===0||ST.grp.includes(r.grupo))
  );
}
function dosBadge(dos){
  if (dos==null) return '<span class="mb-lo">sem venda 90d</span>';
  const cls = dos<=45?'mb-hi':dos<=90?'mb-md':'mb-lo';
  return `<span class="${cls}">${fN(dos)} dias</span>`;
}

// ── CASCATA — Cobertura de Estoque (Categoria → Grupo → Produto) ──────────
// Reaproveita computeEstoqueDOS (já agrupa por produto antes de somar, evitando
// duplicar contagem quando o mesmo produto está com vários vendedores).
let estoqueCascataExpanded = new Set();
function toggleEstoqueCascata(pathKey){
  if (estoqueCascataExpanded.has(pathKey)) estoqueCascataExpanded.delete(pathKey); else estoqueCascataExpanded.add(pathKey);
  renderEstoque();
}
function buildEstoqueCascadeTree(rows, keys, depth, p90){
  depth = depth||0;
  const key = keys[depth];
  const isLeafLevel = depth===keys.length-1;
  const groups = {};
  rows.forEach(r=>{ const k=r[key]; if(!groups[k]) groups[k]=[]; groups[k].push(r); });
  const node = {};
  Object.keys(groups).forEach(k=>{
    const subset = groups[k];
    const agg = computeEstoqueDOS(subset, p90, 90);
    node[k] = {
      valorTotal: agg.valorTotal, saldoTotal: agg.saldoTotal, dos: agg.dos,
      descricao: (isLeafLevel && key==='codproduto') ? subset[0].descricao : null,
      children: isLeafLevel ? null : buildEstoqueCascadeTree(subset, keys, depth+1, p90)
    };
  });
  return node;
}
function estoqueCascadeRowHtml(nome, nivel, pathKey, node){
  const hasChildren = node.children && Object.keys(node.children).length>0;
  const expanded = estoqueCascataExpanded.has(pathKey);
  const toggle = hasChildren ? `<span class="casc-toggle" onclick="toggleEstoqueCascata('${pathKey.replace(/'/g,"\\'")}')">${expanded?'−':'+'}</span>` : '<span class="casc-toggle-spacer"></span>';
  const indent = nivel*18;
  return `<tr class="casc-lvl${nivel}"><td style="padding-left:${indent}px">${toggle}${escAttr(nome)}</td>
    <td class="tv">${fF(node.valorTotal)}</td><td class="tv">${fN(node.saldoTotal)}</td><td class="tv">${dosBadge(node.dos)}</td></tr>`;
}
function renderEstoqueCascadeRows(nodesObj, pathNames, nivel, prefix){
  prefix = prefix || 'ESTQ';
  const entries = Object.keys(nodesObj).map(key=>({key, node:nodesObj[key]})).sort((a,b)=>b.node.valorTotal-a.node.valorTotal);
  let html = '';
  entries.forEach(({key,node})=>{
    const displayName = node.descricao || key;
    const path = pathNames.concat([key]);
    const pathKey = prefix+'|||'+path.join('|||');
    html += estoqueCascadeRowHtml(displayName, nivel, pathKey, node);
    if (node.children && estoqueCascataExpanded.has(pathKey)){
      html += renderEstoqueCascadeRows(node.children, path, nivel+1, prefix);
    }
  });
  return html;
}

// ── CASCATA — Estoque Parado >90 dias (Categoria → Grupo → Produto) ───────
// Mesmo critério já usado na lista plana (por par vendedor×produto, DOS em
// UNIDADES) — só reorganiza em árvore. "Cobertura" no nó agregado = a PIOR
// (maior) cobertura entre os itens dali para baixo — sinaliza o caso mais crítico.
function buildEstoqueParadosCascadeTree(paradosRows, keys, depth){
  depth = depth||0;
  const key = keys[depth];
  const isLeafLevel = depth===keys.length-1;
  const groups = {};
  paradosRows.forEach(r=>{ const k=r[key]; if(!groups[k]) groups[k]=[]; groups[k].push(r); });
  const node = {};
  Object.keys(groups).forEach(k=>{
    const subset = groups[k];
    const valorTotal = subset.reduce((s,r)=>s+r.valor_carga,0);
    const saldoTotal = subset.reduce((s,r)=>s+r.saldo,0);
    const hasNeverSold = subset.some(r=>r.dos==null);
    const finiteDos = subset.filter(r=>r.dos!=null).map(r=>r.dos);
    node[k] = {
      valorTotal, saldoTotal, nItens: subset.length, hasNeverSold,
      worstDos: finiteDos.length ? Math.max(...finiteDos) : null,
      descricao: (isLeafLevel && key==='codproduto') ? subset[0].descricao : null,
      children: isLeafLevel ? null : buildEstoqueParadosCascadeTree(subset, keys, depth+1)
    };
  });
  return node;
}
function estoqueParadosCoberturaBadge(node){
  if (node.hasNeverSold) return '<span class="mb-lo">sem venda 90d</span>';
  if (node.worstDos!=null) return dosBadge(node.worstDos);
  return '<span style="color:var(--t3)">—</span>';
}
function estoqueParadosRowHtml(nome, nivel, pathKey, node){
  const hasChildren = node.children && Object.keys(node.children).length>0;
  const expanded = estoqueCascataExpanded.has(pathKey);
  const toggle = hasChildren ? `<span class="casc-toggle" onclick="toggleEstoqueCascata('${pathKey.replace(/'/g,"\\'")}')">${expanded?'−':'+'}</span>` : '<span class="casc-toggle-spacer"></span>';
  const indent = nivel*18;
  return `<tr class="casc-lvl${nivel}"><td style="padding-left:${indent}px">${toggle}${escAttr(nome)}</td>
    <td class="tv">${fF(node.valorTotal)}</td><td class="tv">${fN(node.saldoTotal)}</td><td class="tv">${fN(node.nItens)}</td><td class="tv">${estoqueParadosCoberturaBadge(node)}</td></tr>`;
}
function renderEstoqueParadosCascadeRows(nodesObj, pathNames, nivel){
  const entries = Object.keys(nodesObj).map(key=>({key, node:nodesObj[key]})).sort((a,b)=>b.node.valorTotal-a.node.valorTotal);
  let html = '';
  entries.forEach(({key,node})=>{
    const displayName = node.descricao || key;
    const path = pathNames.concat([key]);
    const pathKey = 'ESTQP|||'+path.join('|||');
    html += estoqueParadosRowHtml(displayName, nivel, pathKey, node);
    if (node.children && estoqueCascataExpanded.has(pathKey)){
      html += renderEstoqueParadosCascadeRows(node.children, path, nivel+1);
    }
  });
  return html;
}
function renderEstoque(){
  const est = REAL_DATA._estoque;
  const d = curPeriod();
  const p90 = d.por_produto_janela90 || {};
  const win = d.janela90;
  if (!est){ document.getElementById('estoqueSub').textContent = "Dados de estoque não disponíveis."; return; }

  document.getElementById('estoqueSub').textContent = `Estoque atual (fotografia única, ${fN(est.linhas_com_saldo)} linhas com saldo &gt; 0) x venda média/dia — janela ${win?win.inicio+' a '+win.fim:'—'} (mesma do período selecionado)`;

  const rows = estoqueFilterRows(est);
  const geral = computeEstoqueDOS(rows, p90, 90);

  // Produtos > 90 dias (grão fino: por par vendedor×produto, DOS em UNIDADES)
  const produtos90 = rows.map(r=>{
    const v90 = p90[r.codproduto];
    const avgDailyQ = v90 ? v90.q/90 : 0;
    const dos = avgDailyQ>0 ? r.saldo/avgDailyQ : null; // null = zero venda em 90 dias = pior caso
    return {...r, avgDailyQ, dos};
  }).filter(r=>r.dos==null || r.dos>90);
  produtos90.sort((a,b)=>{
    if (a.dos==null && b.dos==null) return b.valor_carga-a.valor_carga;
    if (a.dos==null) return -1; if (b.dos==null) return 1;
    return b.dos-a.dos;
  });

  document.getElementById('estoque-kpis').innerHTML = [
    {lbl:"Valor de Estoque (recorte)", val:fF(geral.valorTotal)},
    {lbl:"Unidades em Estoque (recorte)", val:fN(geral.saldoTotal)},
    {lbl:"Cobertura Média (valor-ponderada)", val: geral.dos!=null?fN(geral.dos)+" dias":"sem venda 90d"},
    {lbl:"Itens (vend.×produto) c/ cobertura > 90d", val:fN(produtos90.length)+" de "+fN(rows.length)},
  ].map((k,i)=>`<div class="kpi k${i}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-val">${k.val}</div></div>`).join("");

  // "Cobertura por Categoria" agora em cascata (Categoria → Grupo → Produto).
  const treeCat = buildEstoqueCascadeTree(rows, ['categoria','grupo','codproduto'], 0, p90);
  document.getElementById('tEstoqueCat').innerHTML = `<thead><tr><th>Categoria / Grupo / Produto</th><th class="tv">Valor Estoque</th><th class="tv">Unidades</th><th class="tv">Cobertura</th></tr></thead><tbody>${renderEstoqueCascadeRows(treeCat, [], 0, 'ESTQ')}</tbody>`;

  // "Cobertura por Gerente/Supervisor/Vendedor" agora em cascata (Gerente → Supervisor → Vendedor).
  const treeHier = buildEstoqueCascadeTree(rows, ['gerente','supervisor','vendedor'], 0, p90);
  document.getElementById('tEstoqueHier').innerHTML = `<thead><tr><th>Gerente / Supervisor / Vendedor</th><th class="tv">Valor Estoque</th><th class="tv">Unidades</th><th class="tv">Cobertura</th></tr></thead><tbody>${renderEstoqueCascadeRows(treeHier, [], 0, 'ESTQH')}</tbody>`;

  // Estoque parado (>90 dias) também em cascata (Categoria → Grupo → Produto).
  document.getElementById('estoque90Sub').textContent = `${fN(produtos90.length)} itens (vendedor × produto) encontrados acima de 90 dias de cobertura`;
  const treeParados = buildEstoqueParadosCascadeTree(produtos90, ['categoria','grupo','codproduto'], 0);
  document.getElementById('tEstoque90').innerHTML = `<thead><tr><th>Categoria / Grupo / Produto</th><th class="tv">Valor Parado</th><th class="tv">Unidades Paradas</th><th class="tv">Itens (vend.×produto)</th><th class="tv">Pior Cobertura</th></tr></thead><tbody>${renderEstoqueParadosCascadeRows(treeParados, [], 0)}</tbody>`;
}

// ── 6E2. VENDAS POR TIPO DE PAGAMENTO ─────────────────────────
// tipo (col. "tipo") = documento fiscal: Danfe (NF) / Cupom.
// tipocob (col. "tipocob") = forma de pagamento: BOLETO/DINHEIRO/PIX/CHEQUE/OUTROS.
// Cubo: pagamento_por_categoria (empresa, por categoria) + hier_pagamento_por_categoria
// (Gerente/Supervisor/Vendedor, por categoria) — cada nó é {Danfe:{tipocob:valor}, Cupom:{tipocob:valor}}.
const TIPO_DOC = ["Danfe","Cupom"];
const TIPO_DOC_LABEL = {Danfe:"NF (Danfe)", Cupom:"Cupom"};
const TIPO_PAG = ["BOLETO","DINHEIRO","PIX","CHEQUE","OUTROS"];
function pagValor(entry, tipo, tipocob){ return (entry && entry[tipo] && entry[tipo][tipocob]) || 0; }
function pagTotalTipo(entry, tipo){ return entry && entry[tipo] ? Object.values(entry[tipo]).reduce((a,b)=>a+b,0) : 0; }
function pagTotalMetodo(entry, tipocob){ let s=0; TIPO_DOC.forEach(t=>{ s+=pagValor(entry,t,tipocob); }); return s; }
// Soma o cubo {categoria: {tipo:{tipocob:valor}}} das categorias informadas num único {tipo:{tipocob:valor}}.
function mergePagamentoCategorias(catDict, catNames){
  const merged = {};
  (catNames||[]).forEach(cat=>{
    const ce = catDict && catDict[cat]; if (!ce) return;
    Object.keys(ce).forEach(tipo=>{
      if (!merged[tipo]) merged[tipo] = {};
      Object.keys(ce[tipo]).forEach(tc=>{ merged[tipo][tc] = (merged[tipo][tc]||0) + ce[tipo][tc]; });
    });
  });
  return merged;
}
// Entrada agregada de UMA entidade (gerente/supervisor/vendedor) — soma as categorias
// selecionadas em ST.cat (ou todas, se nenhuma selecionada) a partir do cubo hierárquico.
function entityPagamentoEntry(d, level, name){
  const dict = d.hier_pagamento_por_categoria && d.hier_pagamento_por_categoria[level] && d.hier_pagamento_por_categoria[level][name];
  if (!dict) return {};
  const cats = ST.cat.length ? ST.cat.filter(c=>dict[c]) : Object.keys(dict);
  return mergePagamentoCategorias(dict, cats);
}
function buildPagRowsTable(rows, tipo, prevFn){
  return `<thead><tr><th>Nome</th>${TIPO_PAG.map(tp=>`<th class="tv">${tp}</th>`).join("")}<th class="tv">Total ${TIPO_DOC_LABEL[tipo]}</th><th class="tv">Δ vs ano ant.</th></tr></thead><tbody>${
    rows.map(r=>{
      const total = pagTotalTipo(r.entry, tipo);
      const prevTotal = prevFn ? prevFn(r.nome) : null;
      return `<tr><td class="tn">${r.nome}</td>${TIPO_PAG.map(tp=>`<td class="tv">${fF(pagValor(r.entry,tipo,tp))}</td>`).join("")}<td class="tv tn">${fF(total)}</td><td class="tv">${deltaPillSmall(total,prevTotal)}</td></tr>`;
    }).join("")}</tbody>`;
}
function renderPagamento(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  if (!d.pagamento_por_categoria){ document.getElementById('pag-kpis').innerHTML = '<div class="alert">Sem dados de tipo de pagamento para este período.</div>'; return; }

  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  const notes = [];
  if (level) notes.push(`Recortado por ${level} — <strong>${labelJoin(names)}</strong>.`);
  if (ST.cat.length) notes.push(`Filtrado por Categoria — <strong>${labelJoin(ST.cat)}</strong>.`);
  document.getElementById('pagFilterNote').innerHTML = notes.length ? `<div class="alert">${notes.join(" ")} Todos os totais abaixo (KPIs e tabelas) refletem exatamente esse recorte (cubo hierárquico Gerente/Supervisor/Vendedor × Categoria × Tipo de Pagamento).</div>` : "";

  // KPIs gerais: sob filtro de Gerente/Supervisor/Vendedor, soma as entidades
  // selecionadas via o cubo hierárquico (entityPagamentoEntry já respeita ST.cat);
  // sem filtro de hierarquia, soma direto o total da empresa por categoria.
  function scopedGeralEntry(period){
    if (!period) return null;
    if (level){
      const merged = {};
      names.forEach(n=>{
        const e = entityPagamentoEntry(period, level, n);
        Object.keys(e).forEach(tipo=>{
          if (!merged[tipo]) merged[tipo] = {};
          Object.keys(e[tipo]).forEach(tc=>{ merged[tipo][tc] = (merged[tipo][tc]||0) + e[tipo][tc]; });
        });
      });
      return merged;
    }
    if (!period.pagamento_por_categoria) return null;
    const cats = Object.keys(period.pagamento_por_categoria).filter(n=>ST.cat.length===0||ST.cat.includes(n));
    return mergePagamentoCategorias(period.pagamento_por_categoria, cats);
  }
  const geralEntry = scopedGeralEntry(d);
  const prevGeralEntry = scopedGeralEntry(prev);
  const totalNF = pagTotalTipo(geralEntry,'Danfe'), totalCupom = pagTotalTipo(geralEntry,'Cupom');
  const prevNF = prevGeralEntry?pagTotalTipo(prevGeralEntry,'Danfe'):null, prevCupom = prevGeralEntry?pagTotalTipo(prevGeralEntry,'Cupom'):null;
  const kpiDefs = [
    {lbl:"Total Geral", val:fM(totalNF+totalCupom), cur:totalNF+totalCupom, prevv: prevGeralEntry?(prevNF+prevCupom):null},
    {lbl:"Total NF (Danfe)", val:fM(totalNF), cur:totalNF, prevv:prevNF},
    {lbl:"Total Cupom", val:fM(totalCupom), cur:totalCupom, prevv:prevCupom},
  ].concat(TIPO_PAG.map(tp=>{
    const v = pagTotalMetodo(geralEntry, tp);
    const pv = prevGeralEntry ? pagTotalMetodo(prevGeralEntry, tp) : null;
    return {lbl:tp, val:fM(v), cur:v, prevv:pv};
  }));
  document.getElementById('pag-kpis').innerHTML = kpiDefs.map((k,i)=>`
    <div class="kpi k${i%7}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-val">${k.val}</div>
      ${deltaPillSmall(k.cur,k.prevv)}
      <div class="kpi-note">vs. mesmo semestre ano anterior</div>
    </div>`).join("");

  // ── Por Categoria (sob filtro de hierarquia, usa o cubo hier_pagamento_por_categoria — exato) ──
  function hierUnionPagamentoCategoria(period, lvl, nms){
    const merged = {};
    const src = period && period.hier_pagamento_por_categoria && period.hier_pagamento_por_categoria[lvl];
    if (!src) return merged;
    nms.forEach(n=>{
      const catDict = src[n]; if (!catDict) return;
      Object.keys(catDict).forEach(cat=>{
        if (!merged[cat]) merged[cat] = {};
        const ce = catDict[cat];
        Object.keys(ce).forEach(tipo=>{
          if (!merged[cat][tipo]) merged[cat][tipo] = {};
          Object.keys(ce[tipo]).forEach(tc=>{ merged[cat][tipo][tc] = (merged[cat][tipo][tc]||0) + ce[tipo][tc]; });
        });
      });
    });
    return merged;
  }
  const catBase = level ? hierUnionPagamentoCategoria(d, level, names) : d.pagamento_por_categoria;
  const prevCatBase = level ? hierUnionPagamentoCategoria(prev, level, names) : (prev ? prev.pagamento_por_categoria : null);
  const catNamesAll = Object.keys(catBase).filter(n=>ST.cat.length===0||ST.cat.includes(n));
  const catRows = catNamesAll.map(n=>({nome:n, entry:catBase[n]}))
    .sort((a,b)=>(pagTotalTipo(b.entry,'Danfe')+pagTotalTipo(b.entry,'Cupom'))-(pagTotalTipo(a.entry,'Danfe')+pagTotalTipo(a.entry,'Cupom')));
  document.getElementById('tPagCatNF').innerHTML = buildPagRowsTable(catRows, 'Danfe', n => (prevCatBase && prevCatBase[n]) ? pagTotalTipo(prevCatBase[n], 'Danfe') : null);
  document.getElementById('tPagCatCupom').innerHTML = buildPagRowsTable(catRows, 'Cupom', n => (prevCatBase && prevCatBase[n]) ? pagTotalTipo(prevCatBase[n], 'Cupom') : null);

  // ── Por Gerente / Supervisor / Vendedor (cascata Gerente → Supervisor → Vendedor) ──
  function entityRowsFor(level, names){
    return names.map(n=>({nome:n, entry: entityPagamentoEntry(d, level, n)}))
      .sort((a,b)=>(pagTotalTipo(b.entry,'Danfe')+pagTotalTipo(b.entry,'Cupom'))-(pagTotalTipo(a.entry,'Danfe')+pagTotalTipo(a.entry,'Cupom')));
  }
  function prevEntityFn(level, name, tipo){
    if (!prev) return null;
    const e = entityPagamentoEntry(prev, level, name);
    return Object.keys(e).length ? pagTotalTipo(e, tipo) : null;
  }

  const gerNames = gerenteCascadeRows(d).map(([n])=>n);
  const gerRows = entityRowsFor('gerente', gerNames);
  document.getElementById('tPagGerNF').innerHTML = buildPagRowsTable(gerRows, 'Danfe', n=>prevEntityFn('gerente',n,'Danfe'));
  document.getElementById('tPagGerCupom').innerHTML = buildPagRowsTable(gerRows, 'Cupom', n=>prevEntityFn('gerente',n,'Cupom'));

  const effGer = effectiveGerentes(d), effSup = effectiveSupervisores(d);
  const supNames = Object.keys(d.por_supervisor).filter(n=>(!effSup||effSup.has(n))&&(!effGer||effGer.has(d.por_supervisor[n].gerente)));
  const supRows = entityRowsFor('supervisor', supNames);
  document.getElementById('tPagSupNF').innerHTML = buildPagRowsTable(supRows, 'Danfe', n=>prevEntityFn('supervisor',n,'Danfe'));
  document.getElementById('tPagSupCupom').innerHTML = buildPagRowsTable(supRows, 'Cupom', n=>prevEntityFn('supervisor',n,'Cupom'));

  const vendNames = Object.keys(d.full_vendedores).filter(n=>(ST.vend.length===0||ST.vend.includes(n))&&(!effSup||effSup.has(d.full_vendedores[n].supervisor)));
  const vendRows = entityRowsFor('vendedor', vendNames);
  document.getElementById('pagVendSub').textContent = `${vendRows.length} vendedores`;
  document.getElementById('tPagVendNF').innerHTML = buildPagRowsTable(vendRows, 'Danfe', n=>prevEntityFn('vendedor',n,'Danfe'));
  document.getElementById('tPagVendCupom').innerHTML = buildPagRowsTable(vendRows, 'Cupom', n=>prevEntityFn('vendedor',n,'Cupom'));
}

// ── 6F. RISCOS & OPORTUNIDADES (GERAL + POR CATEGORIA) ────────
// Cada função abaixo é uma REGRA determinística sobre os números reais do
// período (curPeriod()) e do mesmo semestre do ano anterior (PREV_OF) — não
// há texto fixo por nome de categoria/gerente, então o resultado se recalcula
// sozinho se o usuário trocar o filtro de Período.
function roCard(cls, badge, titulo, corpo, acao){
  return `<div class="risk-card ${cls}"><div class="risk-head"><span class="risk-badge">${badge}</span><span class="risk-title">${titulo}</span></div>
    <div class="risk-body">${corpo}</div>${acao?`<div class="risk-acao">${acao}</div>`:""}</div>`;
}
function roOportCard(titulo, corpo, valor){
  return `<div class="risk-card bx"><div class="risk-head"><span class="risk-badge">OPORTUNIDADE</span><span class="risk-title">${titulo}</span></div>
    <div class="risk-body">${corpo}</div>${valor!=null?`<div class="oport-meta">≈ ${fF(valor)}</div>`:""}</div>`;
}

// Cascata usada pela oportunidade "replicar crescimento": sem filtro de
// hierarquia, compara Gerentes; com Gerente ativo (só), compara Supervisores
// dentro dele; com Supervisor ativo (só), compara Vendedores dentro dele; com
// Vendedor ativo, não há nível mais granular — a oportunidade não se aplica.
function cascadeGrowthCandidates(d, prev, level){
  let entries, prevDict, label;
  if (!level){ entries = Object.entries(d.por_gerente); prevDict = prev?prev.por_gerente:null; label='Gerente'; }
  else if (level==='gerente'){ entries = Object.entries(d.por_supervisor).filter(([,v])=>ST.ger.includes(v.gerente)); prevDict = prev?prev.por_supervisor:null; label='Supervisor'; }
  else if (level==='supervisor'){ entries = Object.entries(d.full_vendedores).filter(([,v])=>ST.sup.includes(v.supervisor)); prevDict = prev?prev.full_vendedores:null; label='Vendedor'; }
  else { return null; }
  return { entries, prevDict, label };
}

function computeRiscosGeral(d, prev, est, level, names){
  const riscos = [];
  const catEntries = categoriaCascadeRows(d).rows;
  const scopeReceita = catEntries.reduce((s,[,v])=>s+v.r,0);
  const catsByReceita = catEntries.slice().sort((a,b)=>b[1].r-a[1].r);

  // 1. Concentração de portfólio (produto + categoria) — dentro do recorte ativo
  const prodBase = topProdutosFonte(d, level, names);
  const prodScoped = prodBase.filter(p=>ST.cat.length===0||ST.cat.includes(p.categoria)).sort((a,b)=>b.r-a.r);
  const topProd = prodScoped[0];
  const topCat = catsByReceita[0];
  if (topProd && topCat){
    const shareProd = scopeReceita>0 ? topProd.r/scopeReceita*100 : 0;
    const shareCat = scopeReceita>0 ? topCat[1].r/scopeReceita*100 : 0;
    const sev1 = shareCat>=60?"CRÍTICO":shareCat>=40?"ALTO":"MÉDIO";
    riscos.push(roCard(sev1==="CRÍTICO"?"cr":sev1==="ALTO"?"al":"me", sev1, "Concentração extrema de portfólio",
      `Um único produto (<strong>${topProd.nome}</strong>) responde por <strong>${shareProd.toFixed(1)}%</strong> da receita do recorte. A categoria <strong>${topCat[0]}</strong> sozinha soma <strong>${shareCat.toFixed(1)}%</strong>.`,
      "Ruptura de fornecimento, mudança regulatória ou queda de demanda neste produto/categoria atinge o resultado consolidado."));
  }

  // 2. Clientes ativos em queda — só decidível SEM filtro de hierarquia (n_cli não
  // é recortável por Gerente/Supervisor/Vendedor neste cubo); com hierarquia ativa,
  // usa direto a categoria em maior retração (que É exata via cubo hierárquico).
  const deltaCli = (!level && prev && prev.n_cli>0) ? (d.n_cli-prev.n_cli)/prev.n_cli*100 : null;
  if (deltaCli!=null && deltaCli<0){
    const sev2 = deltaCli<-8?"CRÍTICO":deltaCli<-4?"ALTO":"MÉDIO";
    riscos.push(roCard(sev2==="CRÍTICO"?"cr":sev2==="ALTO"?"al":"me", sev2, "Queda na base de clientes ativos",
      `Base ativa caiu de <strong>${fN(prev.n_cli)}</strong> para <strong>${fN(d.n_cli)}</strong> clientes (<strong>${deltaCli.toFixed(1)}%</strong>, ${fN(prev.n_cli-d.n_cli)} contas a menos) vs. o mesmo semestre do ano anterior.`,
      "Priorizar diagnóstico de churn e plano de reativação sobre as contas que deixaram de comprar."));
  } else {
    const catDeltas = catsByReceita.map(([n,v])=>{
      const pv = categoriaValueFor(prev, level, names, n);
      const dl = pv && pv.r>0 ? (v.r-pv.r)/pv.r*100 : null;
      return {n,v,pv,dl};
    }).filter(x=>x.dl!=null).sort((a,b)=>a.dl-b.dl);
    if (catDeltas.length && catDeltas[0].dl<0){
      const w = catDeltas[0];
      const sev2 = w.dl<-15?"ALTO":"MÉDIO";
      riscos.push(roCard(sev2==="ALTO"?"al":"me", sev2, `Retração de receita em ${w.n}`,
        `Receita caiu <strong>${Math.abs(w.dl).toFixed(1)}%</strong> vs. o mesmo semestre do ano anterior (${fF(w.pv.r)} → ${fF(w.v.r)}).`,
        "Investigar causa (mix, preço, positivação) — ver aba Motivos da Variação e Planos de Ação."));
    }
  }

  // 3. ABCD: receita concentrada em clientes de baixa margem (Classe B) — exato
  // via cubo hierárquico (hier_abcd), não depende de categoria.
  const a = level ? hierUnionAbcd(level, names) : d.abcd;
  const totalReceitaAbcd = level ? (a.A.receita+a.B.receita+a.C.receita+a.D.receita) : d.receita;
  const medianaMargemAbcd = d.abcd.mediana_margem; // mediana é sempre global (ver renderAbcd)
  const pctB = totalReceitaAbcd>0 ? a.B.receita/totalReceitaAbcd*100 : 0;
  const sev3 = pctB>=55?"ALTO":"MÉDIO";
  riscos.push(roCard(sev3==="ALTO"?"al":"me", sev3, "Receita concentrada em clientes de baixa margem",
    `Classe B (alta venda + baixa margem) reúne <strong>${fN(a.B.count)}</strong> clientes e <strong>${pctB.toFixed(1)}%</strong> da receita do recorte (${fF(a.B.receita)}) — todos abaixo da margem mediana da empresa (${fPct(medianaMargemAbcd)}).`,
    "Revisar política comercial/desconto destas contas — volume alto não está compensando a rentabilidade."));

  // 4. Categoria com pior margem vs. média da empresa — dentro do recorte
  const catsByMargem = catsByReceita.slice().sort((a,b)=>a[1].m-b[1].m);
  const worst = catsByMargem[0];
  if (worst){
    const gapWorst = worst[1].m - d.margem_geral;
    if (gapWorst<0){
      const sev4 = gapWorst<-15?"CRÍTICO":gapWorst<-5?"ALTO":"MÉDIO";
      riscos.push(roCard(sev4==="CRÍTICO"?"cr":sev4==="ALTO"?"al":"me", sev4, `Margem abaixo da média em ${worst[0]}`,
        `Margem de <strong>${fPct(worst[1].m)}</strong>, <strong>${Math.abs(gapWorst).toFixed(1)} p.p.</strong> abaixo da média da empresa (${fPct(d.margem_geral)}) — ${fF(worst[1].r)} de receita rodando com rentabilidade reduzida.`,
        "Ver Plano de Ação desta categoria para pilares de recuperação de margem."));
    }
  }

  // 5. Estoque parado (já respeita Gerente/Supervisor/Vendedor/Categoria — dado linha a linha)
  if (est){
    const p90 = d.por_produto_janela90 || {};
    const rows = estoqueFilterRows(est);
    const geral = computeEstoqueDOS(rows, p90, 90);
    const parados = rows.map(r=>{
      const v90 = p90[r.codproduto];
      const avgDailyValor = v90 ? v90.r/90 : 0;
      return {r, parado: avgDailyValor<=0 || (r.valor_carga/(avgDailyValor||1))>90};
    }).filter(x=>x.parado);
    const valorParado = parados.reduce((s,x)=>s+x.r.valor_carga,0);
    const pctParado = geral.valorTotal>0 ? valorParado/geral.valorTotal*100 : 0;
    const sev5 = pctParado>=10?"ALTO":"MÉDIO";
    riscos.push(roCard(sev5==="ALTO"?"al":"me", sev5, "Capital parado em estoque de baixo giro",
      `<strong>${fN(parados.length)}</strong> itens (vendedor × produto) com mais de 90 dias de cobertura ou nenhuma venda na janela de 90 dias — <strong>${fF(valorParado)}</strong> parados (${pctParado.toFixed(1)}% do valor de estoque do recorte, ${fF(geral.valorTotal)}).`,
      "Ver aba Estoque x Venda para a lista completa de produtos e priorizar giro/negociação com o fornecedor."));
  }

  return riscos.slice(0,5);
}

function computeOportunidadesGeral(d, prev, level, names){
  const oports = [];
  const catEntries = categoriaCascadeRows(d).rows;

  // 1. Replicar crescimento — cascata Gerente → Supervisor → Vendedor conforme filtro ativo
  const casc = cascadeGrowthCandidates(d, prev, level);
  if (casc && casc.prevDict){
    const deltas = casc.entries.map(([n,v])=>{
      const pv = casc.prevDict[n];
      const dl = pv && pv.r>0 ? (v.r-pv.r)/pv.r*100 : null;
      return {n,v,pv,dl};
    }).filter(x=>x.dl!=null).sort((a,b)=>b.dl-a.dl);
    if (deltas.length){
      const g = deltas[0];
      oports.push(roOportCard(`Replicar o crescimento de ${g.n} (${casc.label})`,
        `Crescimento de <strong>+${g.dl.toFixed(1)}%</strong> vs. o mesmo semestre do ano anterior (${fF(g.pv.r)} → ${fF(g.v.r)}) — ganho já comprovado neste território, candidato a ter a prática replicada nos demais.`,
        g.v.r-g.pv.r));
    }
  }

  // 2/3. Up-sell e Cross-sell por positivação — não recortável por Gerente/
  // Supervisor/Vendedor neste cubo (contagem de clientes por categoria só existe
  // no nível empresa); com hierarquia ativa, estas duas oportunidades são omitidas
  // em vez de mostrar um número que não corresponde ao recorte selecionado.
  if (!level){
    const cats = catEntries.map(([n,v])=>({n,v,pos: d.n_cli>0?v.n_clientes/d.n_cli*100:0}));
    const upsell = cats.filter(c=>c.pos<70 && c.v.r>0).sort((a,b)=>b.v.m-a.v.m);
    let upsellName = null;
    if (upsell.length){
      const c = upsell[0]; upsellName = c.n;
      const ticket = c.v.n_clientes>0 ? c.v.r/c.v.n_clientes : 0;
      const ganho = 0.10*d.n_cli*ticket;
      oports.push(roOportCard(`Up-sell em ${c.n}`,
        `Melhor margem entre as categorias (<strong>${fPct(c.v.m)}</strong>), mas apenas <strong>${c.pos.toFixed(1)}%</strong> da base ativa comprou algo dela. Cenário ilustrativo: +10 p.p. de positivação, ao ticket médio atual da categoria.`,
        ganho));
    }
    const cross = cats.filter(c=>c.v.r>0).slice().sort((a,b)=>a.pos-b.pos);
    if (cross.length && cross[0].n !== upsellName){
      const c = cross[0];
      const ticket = c.v.n_clientes>0 ? c.v.r/c.v.n_clientes : 0;
      const ganho = 0.10*d.n_cli*ticket;
      oports.push(roOportCard(`Cross-sell em ${c.n}`,
        `Menor positivação entre as categorias (<strong>${c.pos.toFixed(1)}%</strong> da base ativa). Cenário ilustrativo: +10 p.p. de positivação, ao ticket médio atual da categoria.`,
        ganho));
    }
  }

  // 4. Fechar gap de margem da categoria com pior margem — dentro do recorte
  const catsByMargem = catEntries.slice().sort((a,b)=>a[1].m-b[1].m);
  const worst = catsByMargem[0];
  if (worst && worst[1].m < d.margem_geral && worst[1].r>0){
    const cashAtual = worst[1].r - worst[1].c;
    const cashSeNaMedia = worst[1].r * (d.margem_geral/100);
    const ganho = cashSeNaMedia - cashAtual;
    if (ganho>0) oports.push(roOportCard(`Elevar margem de ${worst[0]} à média da empresa`,
      `Alinhar a margem de <strong>${fPct(worst[1].m)}</strong> para a média da empresa (<strong>${fPct(d.margem_geral)}</strong>) libera cash margem adicional sem vender mais — mesmo volume de receita, custo mais eficiente.`,
      ganho));
  }

  // 5. Reativação de clientes perdidos (não recortável por hierarquia — n_cli só
  // existe no nível empresa) — com hierarquia ativa, sempre usa Classe C (exata
  // via hier_abcd); sem hierarquia, tenta reativação primeiro.
  const deltaCliAbs = (!level && prev && prev.n_cli>0) ? prev.n_cli-d.n_cli : null;
  if (deltaCliAbs!=null && deltaCliAbs>0){
    const ticketD = d.abcd.D.count>0 ? d.abcd.D.receita/d.abcd.D.count : 0;
    oports.push(roOportCard("Reativação de clientes perdidos",
      `<strong>${fN(deltaCliAbs)}</strong> contas ativas no mesmo semestre do ano anterior e ausentes agora. Estimativa conservadora, usando o ticket médio da Classe D (o mais baixo entre as 4 classes) para não superestimar o potencial.`,
      deltaCliAbs*ticketD));
  } else {
    const a = level ? hierUnionAbcd(level, names) : d.abcd;
    const totalReceitaAbcd = level ? (a.A.receita+a.B.receita+a.C.receita+a.D.receita) : d.receita;
    const c = a.C;
    oports.push(roOportCard("Expandir volume da Classe C (alta margem, baixo volume)",
      `<strong>${fN(c.count)}</strong> clientes com margem acima da mediana (${fPct(d.abcd.mediana_margem)}) mas apenas <strong>${(totalReceitaAbcd>0?(c.receita/totalReceitaAbcd*100):0).toFixed(1)}%</strong> da receita do recorte — aumentar o volume nestas contas preserva a rentabilidade já demonstrada.`,
      c.cash_margin));
  }

  return oports.slice(0,5);
}

function renderRiscoOport(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const est = REAL_DATA._estoque;
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  document.getElementById("riscoGeralNote").innerHTML = level
    ? `<div class="alert">Recortado por ${level} — <strong>${labelJoin(names)}</strong>: riscos/oportunidades por Categoria e Estoque são exatos; "Clientes ativos", "Up-sell/Cross-sell por positivação" e "Reativação" não são recortáveis por Gerente/Supervisor/Vendedor neste cubo e ficam omitidos ou substituídos por uma alternativa equivalente.</div>` : "";
  document.getElementById("riscos-geral-list").innerHTML = computeRiscosGeral(d, prev, est, level, names).join("");
  document.getElementById("oport-geral-list").innerHTML = computeOportunidadesGeral(d, prev, level, names).join("");
}

// Por categoria: 1 risco + 1 oportunidade por categoria, mesma lógica da visão
// geral aplicada célula a célula (sem texto fixo por nome de categoria).
function computeRiscoCategoria(n, v, pv, margemGeral){
  const gap = v.m - margemGeral;
  const deltaR = pv && pv.r>0 ? (v.r-pv.r)/pv.r*100 : null;
  if (gap<-3){
    const sev = gap<-15?"CRÍTICO":gap<-8?"ALTO":"MÉDIO";
    return roCard(sev==="CRÍTICO"?"cr":sev==="ALTO"?"al":"me", sev, `${n}: margem abaixo da média`,
      `Margem de <strong>${fPct(v.m)}</strong>, <strong>${Math.abs(gap).toFixed(1)} p.p.</strong> abaixo da média da empresa (${fPct(margemGeral)}).`);
  }
  if (deltaR!=null && deltaR<-5){
    const sev = deltaR<-15?"ALTO":"MÉDIO";
    return roCard(sev==="ALTO"?"al":"me", sev, `${n}: retração de receita`,
      `Receita caiu <strong>${Math.abs(deltaR).toFixed(1)}%</strong> vs. o mesmo semestre do ano anterior.`);
  }
  return roCard("me", "BAIXO", `${n}: sem risco crítico identificado`,
    `Margem (${fPct(v.m)}) e tendência de receita dentro do esperado nos indicadores disponíveis — manter monitoramento de rotina.`);
}
function computeOportCategoria(n, v, d, margemGeral){
  // v.n_clientes só existe na base flat (sem filtro de hierarquia) — sob filtro
  // de Gerente/Supervisor/Vendedor (cubo hier_por_categoria) não há positivação
  // por categoria, então cai direto nos ramos de margem.
  const pos = (v.n_clientes!=null && d.n_cli>0) ? v.n_clientes/d.n_cli*100 : null;
  const ticket = (v.n_clientes) ? v.r/v.n_clientes : 0;
  if (pos!=null && pos<50){
    const ganho = 0.10*d.n_cli*ticket;
    return roOportCard(`${n}: expandir positivação`,
      `Apenas <strong>${pos.toFixed(1)}%</strong> da base ativa comprou desta categoria. Cenário ilustrativo: +10 p.p. de positivação, ao ticket médio atual.`, ganho);
  }
  if (v.m>margemGeral){
    return roOportCard(`${n}: proteger margem acima da média`,
      `Margem de <strong>${fPct(v.m)}</strong>, já acima da média da empresa (${fPct(margemGeral)}) — manter disciplina de precificação e nível de serviço.`, v.r-v.c);
  }
  return roOportCard(`${n}: sustentar posição atual`,
    `Sem gap crítico adicional identificado além do já mapeado na aba Planos de Ação.`, v.r-v.c);
}
function renderRiscoOportCat(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const catInfo = categoriaCascadeRows(d);
  const notes = [];
  if (!prev) notes.push("Período sem base de comparação no mesmo semestre do ano anterior — os riscos desta página usam apenas o gap de margem vs. a média da empresa.");
  if (catInfo.level) notes.push(`Recortado por ${catInfo.level} — <strong>${labelJoin(catInfo.names)}</strong>: receita/margem exatos (cubo hierárquico); positivação por categoria não é recortável por Gerente/Supervisor/Vendedor neste cubo.`);
  document.getElementById("riscoCatNote").innerHTML = notes.length ? `<div class="alert">⚠ ${notes.join(" ")}</div>` : "";
  const cats = catInfo.rows.filter(([,v])=>v.r>0).sort((a,b)=>b[1].r-a[1].r);
  document.getElementById("riscos-cat-list").innerHTML = cats.map(([n,v])=>computeRiscoCategoria(n,v, categoriaValueFor(prev, catInfo.level, catInfo.names, n), d.margem_geral)).join("");
  document.getElementById("oport-cat-list").innerHTML = cats.map(([n,v])=>computeOportCategoria(n,v,d,d.margem_geral)).join("");
}

// ── 6H. ANÁLISE EM CASCATA (Categoria > Grupo > Fornecedor > Produto) ──────
// Cubo novo do ETL (d.cascata) — coluna real "fornecedor" nunca usada antes.
// Formatos por nível (para caber no limite de 16MB do Artifact):
//   categoria/grupo: objeto {r,c,q,p,m,n_cli,n_grp|n_for,grupos|fornecedores}
//   fornecedor: array compacto [r,c,q,p,m,n_cli,n_prod,produtos]
//   produto (folha): array compacto [r,c,q,p,n_cli]
let cascataExpanded = new Set();
function toggleCascata(pathKey){
  if (cascataExpanded.has(pathKey)) cascataExpanded.delete(pathKey); else cascataExpanded.add(pathKey);
  renderCascata();
}
// Normaliza qualquer nó (objeto ou array compacto) para {r,c,q,p,m,nCli,nMix,children}.
function cascataShape(raw){
  if (!raw) return null;
  if (Array.isArray(raw)){
    if (raw.length===8){ // fornecedor: r,c,q,p,m,n_cli,n_prod,produtos
      return {r:raw[0],c:raw[1],q:raw[2],p:raw[3],m:raw[4],nCli:raw[5],nMix:raw[6],children:raw[7]};
    }
    // produto (folha): r,c,q,p,n_cli — sem meta pré-calculada, sem filhos
    const r=raw[0], c=raw[1];
    return {r,c,q:raw[2],p:raw[3],m:r>0?+(100*(1-c/r)).toFixed(2):0,nCli:raw[4],nMix:null,children:null};
  }
  // categoria/grupo: objeto com grupos OU fornecedores
  return {r:raw.r,c:raw.c,q:raw.q,p:raw.p,m:raw.m,nCli:raw.n_cli,nMix:(raw.n_grp!=null?raw.n_grp:raw.n_for),children:(raw.grupos||raw.fornecedores)};
}
// Percorre o cascata do período de comparação (prev) pelo MESMO caminho de nomes.
function cascataPrevLookup(prevCascata, pathNames){
  if (!prevCascata) return null;
  let rawNode = prevCascata[pathNames[0]];
  if (!rawNode) return null;
  let shaped = cascataShape(rawNode);
  for (let i=1;i<pathNames.length;i++){
    if (!shaped || !shaped.children) return null;
    rawNode = shaped.children[pathNames[i]];
    if (!rawNode) return null;
    shaped = cascataShape(rawNode);
  }
  return shaped;
}
function cascataPctDelta(cur, prev){
  if (prev==null || prev===0) return '<span style="color:var(--t3)">sem base</span>';
  const d = (cur-prev)/prev*100;
  return `<span class="delta-pill ${d>=0?'up':'dn'}">${d>=0?'▲':'▼'} ${Math.abs(d).toFixed(1)}%</span>`;
}
function cascataRowHtml(nome, nivel, pathKey, cur, prev){
  const hasChildren = cur.children && Object.keys(cur.children).length>0;
  const expanded = cascataExpanded.has(pathKey);
  const toggle = hasChildren ? `<span class="casc-toggle" onclick="toggleCascata('${pathKey.replace(/'/g,"\\'")}')">${expanded?'−':'+'}</span>` : '<span class="casc-toggle-spacer"></span>';
  const indent = nivel*18;
  const nCliCur = cur.nCli||0, nCliPrev = prev?(prev.nCli||0):null;
  const mixCur = cur.nMix, mixPrev = prev?prev.nMix:null;
  const approxCur = cur.approx ? '≈ ' : '', approxPrev = (prev&&prev.approx) ? '≈ ' : '';
  return `<tr class="casc-lvl${nivel}"><td style="padding-left:${indent}px">${toggle}${escAttr(nome)}</td>
    <td class="tv">${prev?fF(prev.r):'<span style="color:var(--t3)">—</span>'}</td><td class="tv">${fF(cur.r)}</td><td class="tv">${cascataPctDelta(cur.r,prev?prev.r:null)}</td>
    <td class="tv">${prev?fN(prev.q):'—'}</td><td class="tv">${fN(cur.q)}</td><td class="tv">${cascataPctDelta(cur.q,prev?prev.q:null)}</td>
    <td class="tv">${prev?fN(prev.p):'—'}</td><td class="tv">${fN(cur.p)}</td><td class="tv">${cascataPctDelta(cur.p,prev?prev.p:null)}</td>
    <td class="tv">${prev?approxPrev+fN(nCliPrev):'—'}</td><td class="tv">${approxCur}${fN(nCliCur)}</td><td class="tv">${cascataPctDelta(nCliCur,nCliPrev)}</td>
    <td class="tv">${mixPrev!=null?fN(mixPrev):'—'}</td><td class="tv">${mixCur!=null?fN(mixCur):'<span style="color:var(--t3)">—</span>'}</td>
    <td class="tv">${prev?margemBadge(prev.m):'<span style="color:var(--t3)">—</span>'}</td><td class="tv">${margemBadge(cur.m)}</td></tr>`;
}
// ── Reordenar hierarquia (Grupo/Fornecedor/Produto) ──────────────────────
// A árvore real do ETL é Grupo>Fornecedor>Produto. Para as outras ordens,
// "achata" as folhas reais e reagrupa no navegador. Faturamento/Qtde/Peso/
// Margem/Mix continuam EXATOS (soma e contagem de distintos não dependem da
// ordem); só "Clientes (Positivação)" em nós intermediários criados pela
// reordenação vira uma APROXIMAÇÃO (soma dos filhos — sem o HashSet real de
// clientes daquele agrupamento sintético, pode contar o mesmo cliente 2x se
// ele aparecer sob mais de um filho). A folha final e o nível Categoria
// continuam com a contagem real exata em qualquer ordem.
let cascataOrder = ['grupo','fornecedor','produto'];
function onCascataOrdemChange(){
  cascataOrder = document.getElementById('fCascataOrdem').value.split(',');
  cascataExpanded.clear();
  renderCascata();
}
function cascataIsDefaultOrder(){ return cascataOrder.join(',')==='grupo,fornecedor,produto'; }
function flattenCascataLeaves(catRawNode){
  const out = [];
  const grupos = (catRawNode && catRawNode.grupos) || {};
  Object.keys(grupos).forEach(grupoNome=>{
    const fornecedores = grupos[grupoNome].fornecedores || {};
    Object.keys(fornecedores).forEach(forNome=>{
      const forRaw = fornecedores[forNome]; // [r,c,q,p,m,n_cli,n_prod,produtos]
      const produtosObj = forRaw[7] || {};
      Object.keys(produtosObj).forEach(prodNome=>{
        const leaf = produtosObj[prodNome]; // [r,c,q,p,n_cli]
        out.push({grupo:grupoNome, fornecedor:forNome, produto:prodNome, r:leaf[0],c:leaf[1],q:leaf[2],p:leaf[3],nCli:leaf[4]});
      });
    });
  });
  return out;
}
function buildCascataTreeFromLeaves(leaves, order, depth){
  depth = depth||0;
  if (depth>=order.length){
    const r=leaves.reduce((s,x)=>s+x.r,0), c=leaves.reduce((s,x)=>s+x.c,0), q=leaves.reduce((s,x)=>s+x.q,0), p=leaves.reduce((s,x)=>s+x.p,0);
    const nCli = leaves.length===1 ? leaves[0].nCli : leaves.reduce((s,x)=>s+x.nCli,0);
    return {r,c,q,p,m:r>0?+(100*(1-c/r)).toFixed(2):0, nCli, nMix:null, children:null, approx:leaves.length>1};
  }
  const key = order[depth];
  const byKey = {};
  leaves.forEach(it=>{ const k=it[key]; if(!byKey[k]) byKey[k]=[]; byKey[k].push(it); });
  const children = {};
  let r=0,c=0,q=0,p=0,nCli=0,anyApprox=false;
  Object.keys(byKey).forEach(k=>{
    const child = buildCascataTreeFromLeaves(byKey[k], order, depth+1);
    children[k]=child;
    r+=child.r; c+=child.c; q+=child.q; p+=child.p; nCli+=child.nCli;
    if (child.approx) anyApprox = true;
  });
  const nMix = Object.keys(children).length;
  return {r,c,q,p,m:r>0?+(100*(1-c/r)).toFixed(2):0, nCli, nMix, children, approx: anyApprox || nMix>1};
}
// Nó de categoria: r/c/q/p/m/nCli sempre exatos (vêm direto do cubo); só a
// árvore de filhos (e o Mix do 1º nível) é substituída pela ordem escolhida.
function cascataCategoriaNode(catRawNode, order){
  const shaped = cascataShape(catRawNode);
  if (!shaped) return null;
  if (order.join(',')==='grupo,fornecedor,produto') return shaped;
  const pivoted = buildCascataTreeFromLeaves(flattenCascataLeaves(catRawNode), order);
  // r/c/q/p/m/nCli da categoria continuam exatos (vêm de "shaped") — só a árvore
  // de filhos e o Mix do 1º nível vêm do pivô; "approx" NÃO se aplica a este nó.
  return {...shaped, nMix: pivoted.nMix, children: pivoted.children};
}
function renderCascataRowsPivot(childrenObj, pathNames, nivel, prevChildrenObj){
  const entries = Object.keys(childrenObj).map(name=>({name, shaped:childrenObj[name]})).sort((a,b)=>b.shaped.r-a.shaped.r);
  let html = '';
  entries.forEach(({name,shaped})=>{
    const path = pathNames.concat([name]);
    const pathKey = 'PIVOT|||'+path.join('|||');
    const prevShaped = prevChildrenObj ? prevChildrenObj[name] : null;
    html += cascataRowHtml(name, nivel, pathKey, shaped, prevShaped);
    if (shaped.children && cascataExpanded.has(pathKey)){
      html += renderCascataRowsPivot(shaped.children, path, nivel+1, prevShaped?prevShaped.children:null);
    }
  });
  return html;
}
function renderCascataRows(nodesObj, pathNames, nivel, prevCascata){
  const entries = Object.keys(nodesObj).map(name=>({name, shaped:cascataShape(nodesObj[name])})).sort((a,b)=>b.shaped.r-a.shaped.r);
  let html = '';
  entries.forEach(({name,shaped})=>{
    const path = pathNames.concat([name]);
    const pathKey = path.join('|||');
    const prevShaped = cascataPrevLookup(prevCascata, path);
    html += cascataRowHtml(name, nivel, pathKey, shaped, prevShaped);
    if (shaped.children && cascataExpanded.has(pathKey)){
      html += renderCascataRows(shaped.children, path, nivel+1, prevCascata);
    }
  });
  return html;
}
function renderCascata(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  if (!d.cascata){ document.getElementById('tCascata').innerHTML=''; document.getElementById('cascataSub').textContent='Sem dados de cascata para este período.'; return; }
  document.getElementById('cascataSub').textContent = `${d.label}` + (prev?` · comparado a ${prev.label}`:' · sem semestre equivalente no ano anterior para comparar');

  const outrosFiltros = ST.ger.length||ST.sup.length||ST.vend.length||ST.grp.length||ST.cli.length||ST.mes!=null;
  document.getElementById('cascataFilterNote').innerHTML = outrosFiltros
    ? `<div class="alert">⚠ Filtro de Gerente/Supervisor/Vendedor/Grupo/Cliente/Mês ativo, mas ignorado nesta aba (cubo só existe fechado por Categoria, nível empresa) — mostrando o semestre inteiro${ST.cat.length?", filtrado pela Categoria selecionada":""}.</div>` : "";

  const catNames = Object.keys(d.cascata).filter(n=>ST.cat.length===0||ST.cat.includes(n));
  const isDefault = cascataIsDefaultOrder();
  const ordemLbl = {grupo:"Grupo",fornecedor:"Fornecedor",produto:"Produto"};
  document.getElementById('cascataOrdemNote').innerHTML = isDefault ? "" :
    `<div class="alert">⚠ Hierarquia reordenada (<strong>${cascataOrder.map(k=>ordemLbl[k]).join(" → ")}</strong>). O nível <strong>Categoria continua 100% exato</strong> (vem direto do cubo). Nos níveis abaixo, esta visão reagrupa a lista de produtos já limitada (Top 8 por Fornecedor/Top 20 por Grupo, ver aviso acima) — <strong>Faturamento/Quantidade/Peso podem ficar levemente subestimados</strong> para um ${ordemLbl[cascataOrder[0]]} com mais itens do que esse limite (o total pode não bater exatamente com a mesma entidade na ordem padrão). <strong>Clientes (Positivação) marcados com ≈ são aproximados</strong> — a soma dos filhos pode contar o mesmo cliente mais de uma vez. Para números exatos por Fornecedor, use a ordem padrão (Grupo → Fornecedor → Produto).</div>`;

  let rowsHtml = '';
  if (isDefault){
    const rootObj = {}; catNames.forEach(n=>{ rootObj[n]=d.cascata[n]; });
    rowsHtml = renderCascataRows(rootObj, [], 0, prev?prev.cascata:null);
  } else {
    catNames.slice().sort((a,b)=>d.cascata[b].r-d.cascata[a].r).forEach(catName=>{
      const shaped = cascataCategoriaNode(d.cascata[catName], cascataOrder);
      const prevShaped = (prev && prev.cascata && prev.cascata[catName]) ? cascataCategoriaNode(prev.cascata[catName], cascataOrder) : null;
      const pathKey = 'PIVOT|||'+catName;
      rowsHtml += cascataRowHtml(catName, 0, pathKey, shaped, prevShaped);
      if (shaped.children && cascataExpanded.has(pathKey)){
        rowsHtml += renderCascataRowsPivot(shaped.children, [catName], 1, prevShaped?prevShaped.children:null);
      }
    });
  }
  document.getElementById('tCascata').innerHTML = `<thead><tr>
    <th>Categoria / ${cascataOrder.map(k=>ordemLbl[k]).join(" / ")}</th>
    <th class="tv">Fat. ano ant.</th><th class="tv">Faturamento</th><th class="tv">Δ%</th>
    <th class="tv">Qtde ano ant.</th><th class="tv">Qtde</th><th class="tv">Δ%</th>
    <th class="tv">Peso KG ano ant.</th><th class="tv">Peso KG</th><th class="tv">Δ%</th>
    <th class="tv">Clientes ano ant.</th><th class="tv">Clientes (Positivação)</th><th class="tv">Δ%</th>
    <th class="tv">Mix ano ant.</th><th class="tv">Mix</th>
    <th class="tv">Margem ano ant.</th><th class="tv">Margem</th>
    </tr></thead><tbody>${rowsHtml}</tbody>`;
}

// ── 7. QUALIDADE DOS DADOS ────────────────────────────────────
function renderQual(){
  const d = curPeriod();
  const prevKey = PREV_OF[ST.per];
  const prev = prevPeriod();
  const q = d.qualidade;
  const qPct = (p,k) => p.qualidade[k]/p.linhas*100;
  const defs = [
    {k:"linhas_sem_cliente", title:"Linhas sem código de cliente"},
    {k:"linhas_sem_produto", title:"Linhas sem código de produto"},
    {k:"linhas_sem_vendedor", title:"Linhas sem código de vendedor"},
    {k:"linhas_receita_zero_ou_negativa", title:"Linhas com receita ≤ 0", extra:" — devoluções/bonificações/cortesias prováveis"},
    {k:"linhas_qtde_zero_ou_negativa", title:"Linhas com quantidade ≤ 0"},
    {k:"linhas_custo_maior_que_receita", title:"Linhas com custo médio > receita (margem negativa)", extra:" — vendas abaixo do custo"},
  ];
  document.getElementById("qualFilterNote").innerHTML = activeFilterCount()>0
    ? `<div class="alert">⚠ Esta aba mostra sempre a base inteira do período, mesmo com filtros ativos — qualidade de dados é uma propriedade do arquivo, não recortável por Gerente/Categoria/Cliente neste cubo.</div>` : "";
  document.getElementById("qual-cards").innerHTML = defs.map(x=>{
    const v = q[x.k];
    const ok = v===0;
    const curPct = qPct(d,x.k);
    const prevPct = prev ? qPct(prev,x.k) : null;
    return `<div class="qual-card ${ok?'qual-ok':'qual-warn'}"><div class="qual-ico">${ok?'✓':'⚠'}</div>
      <div><div class="qual-title">${x.title}</div><div class="qual-body">${fN(v)} linhas (${curPct.toFixed(2)}%)${x.extra||''}</div>
      <div style="margin-top:5px;display:flex;align-items:center;gap:6px">${deltaPP(curPct,prevPct,true)}<span style="font-size:10px;color:var(--t3)">vs. mesmo semestre ano anterior (menos é melhor)</span></div></div></div>`;
  }).join("");
}

// ── EXPORT CSV (respeita filtro de cliente ativo) ────────────────
function exportCSV(){
  const d = curPeriod();
  const rows = filtrarClientes(d.top_clientes);
  let csv = "codigo;cliente;receita;custo;qtde;margem_pct;meses_ativos;categorias\n";
  rows.forEach(r=>{ csv += `${r.codigo};${r.nome};${r.r};${r.c};${r.q};${r.m};${r.meses_ativos};${r.categorias}\n`; });
  const blob = new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `export_${ST.per}.csv`;
  a.click();
}

document.getElementById("sbTog").onclick = () => {
  document.getElementById("sb").classList.toggle("col");
  document.getElementById("topbar").classList.toggle("col");
  document.getElementById("main").classList.toggle("col");
};

// ── AUTHENTICATION ──────────────────────────────────────────────────
let authSession = null;

function checkAuth() {
  const saved = localStorage.getItem('portalAuth');
  if (saved) {
    try {
      authSession = JSON.parse(saved);
      document.getElementById('login-overlay').style.display = 'none';
      return true;
    } catch(e){}
  }
  document.getElementById('login-overlay').style.display = 'flex';
  return false;
}

const AUTH_HOST = 'https://apis.cifaldistribuidora.com.br:8001';

// Token base (credenciais de sistema) — usado tanto no login quanto p/ refazer a
// busca de carteira quando a sessão é restaurada do localStorage sem clientes.
async function getBaseToken(){
  const r = await fetch(`${AUTH_HOST}/auth`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ userName:"cvlima", password:"123" })
  });
  if (!r.ok) throw new Error("Auth base falhou.");
  const j = await r.json();
  if (!j.token) throw new Error("Token não retornado.");
  return j.token;
}

// A API de auth devolve as chaves em PascalCase (CodCliente/CodVendedor/...),
// enquanto o Swagger documenta camelCase. Toda leitura de campo dela passa por
// aqui p/ tolerar as duas grafias.
function pickCI(obj, ...keysLower){
  if (!obj || typeof obj !== 'object') return undefined;
  for (const kk in obj){
    const low = kk.toLowerCase();
    if (keysLower.includes(low)) return obj[kk];
  }
  return undefined;
}

// Executa `fn` sobre `items` com no máximo `limit` requisições simultâneas —
// evita disparar centenas de fetches de uma vez (gerente tem dezenas de vendedores).
async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length){ const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const authGet = (token, path) =>
  fetch(`${AUTH_HOST}${path}`, { headers: { 'Authorization': `Bearer ${token}` } })
    .then(r => r.ok ? r.json() : []).catch(() => []);

// Vendedores da sessão como [{cod, nome}]. Login de SUPERVISOR já traz a lista;
// login de GERENTE traz só `Supervisores`, então buscamos os vendedores de cada
// supervisor em /Roteiro/supervisor/{codSupervisor}/vendedores.
async function resolveVendedoresDaSessao(token, sess){
  const byCod = new Map();
  const addFrom = arr => (Array.isArray(arr) ? arr : []).forEach(v => {
    const cod = pickCI(v, 'codvendedor', 'codven', 'codvend', 'cod');
    if (cod != null && !byCod.has(String(cod))){
      byCod.set(String(cod), { cod, nome: pickCI(v, 'vendedor', 'nomven', 'nome') });
    }
  });

  addFrom(pickCI(sess, 'vendedores'));

  if (!byCod.size){
    const sups = pickCI(sess, 'supervisores');
    const codsSup = (Array.isArray(sups) ? sups : [])
      .map(s => pickCI(s, 'codsupervisor', 'codsup', 'cod'))
      .filter(c => c != null);
    if (codsSup.length){
      const listas = await mapLimit(codsSup, 6, cod => authGet(token, `/Roteiro/supervisor/${cod}/vendedores`));
      listas.forEach(addFrom);
      console.log(`[carteira] ${byCod.size} vendedor(es) obtidos de ${codsSup.length} supervisor(es)`);
    }
  }
  return [...byCod.values()];
}

// Carteira de clientes por vendedor. Extrai SOMENTE codCliente, cliente,
// nomeFantasia. Devolve { todos:[...], byVend:{ [codVendedor]: [...] } }.
async function fetchCarteira(token, vendedores){
  if (!vendedores.length) return { todos: [], byVend: {} };
  const listas = await mapLimit(vendedores, 6, v => authGet(token, `/Roteiro/vendedor/${v.cod}/clientes`));
  const todosByCod = new Map();
  const byVend = {};
  vendedores.forEach((v, i) => {
    const arr = Array.isArray(listas[i]) ? listas[i] : [];
    const doVend = [];
    arr.forEach(c => {
      const cod = pickCI(c, 'codcliente');
      if (cod == null) return;
      const item = { codCliente: cod, cliente: pickCI(c, 'cliente'), nomeFantasia: pickCI(c, 'nomefantasia') };
      doVend.push(item);
      if (!todosByCod.has(String(cod))) todosByCod.set(String(cod), item);
    });
    byVend[String(v.cod)] = doVend;
  });
  return { todos: [...todosByCod.values()], byVend };
}

// Persiste a sessão; carteira grande pode estourar a cota do localStorage — nesse
// caso segue só em memória (a carteira é rebuscada no próximo boot).
function persistAuthSession(){
  try { localStorage.setItem('portalAuth', JSON.stringify(authSession)); }
  catch (e) { console.warn('[carteira] sessão não persistida (cota do localStorage):', e.message); }
}

// Carrega a carteira na sessão (login novo ou sessão restaurada sem clientes).
async function ensureCarteira(){
  if (!authSession) return;
  if (Array.isArray(authSession.clientes) && authSession.clientes.length) return;
  try {
    const token = await getBaseToken();
    const vendedores = await resolveVendedoresDaSessao(token, authSession);
    if (!vendedores.length){
      console.warn('[carteira] nenhum vendedor encontrado p/ esta sessão — filtro Cliente cai no top 50. Chaves da sessão:', Object.keys(authSession));
      return;
    }
    const { todos, byVend } = await fetchCarteira(token, vendedores);
    authSession.vendedoresCarteira = vendedores;
    authSession.clientes = todos;
    authSession.clientesByVend = byVend;
    persistAuthSession();
    console.log(`[carteira] ${todos.length} clientes únicos de ${vendedores.length} vendedor(es)`);
  } catch (e) {
    console.warn('[carteira] falha ao carregar:', e.message);
  }
}

window.doLogin = async function() {
  const role = document.getElementById('loginRole').value; // 'supervisor' ou 'gerente'
  const user = document.getElementById('loginUser').value;
  const pass = document.getElementById('loginPass').value;
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');
  
  btn.disabled = true;
  btn.textContent = "Autenticando...";
  err.textContent = "";

  try {
    // 1. Obter o JWT Token primeiro usando credenciais HARDCODED do sistema
    const authRes = await fetch(`https://apis.cifaldistribuidora.com.br:8001/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: "cvlima", password: "123" })
    });
    
    if (!authRes.ok) throw new Error("Usuário ou senha inválidos no Auth Base.");
    const authData = await authRes.json();
    const token = authData.token;

    if (!token) throw new Error("Token não retornado pela API.");

    // 2. Chamar a rota de elevação de cargo usando o Token
    const res = await fetch(`https://apis.cifaldistribuidora.com.br:8001/Roteiro/${role}/login`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ login: user, senha: pass })
    });
    
    if (!res.ok) throw new Error("Usuário ou senha inválidos.");
    const data = await res.json();
    data.role = role;

    // Sucesso! Salvar na sessão. A carteira de clientes é carregada por
    // ensureCarteira() dentro de loadAndInit (mesmo caminho da sessão restaurada).
    authSession = data;
    persistAuthSession();

    document.getElementById('login-overlay').style.display = 'none';
    
    // Retomar carregamento da API e do painel
    loadAndInit();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
};

window.doLogout = function() {
  localStorage.removeItem('portalAuth');
  authSession = null;
  location.reload();
};

// ── BOOT: busca dados da API (com retry no warm-up) e inicializa ──
async function loadAndInit(){
  if (!checkAuth()) return;

  const overlay = document.getElementById('api-loading');
  const errBox  = document.getElementById('api-error');
  const txt     = document.getElementById('api-loading-txt');
  if (overlay) overlay.style.display = 'flex';
  if (errBox)  errBox.style.display = 'none';

  // Carteira de clientes do usuário (login novo ou sessão restaurada sem ela).
  // Dezenas de requisições → mostra o progresso no overlay.
  if (!(authSession && Array.isArray(authSession.clientes) && authSession.clientes.length)){
    if (txt) txt.textContent = 'Carregando carteira de clientes…';
    await ensureCarteira();
  }
  // O ETL do backend leva ~6-7 min para montar o cache no boot (ver
  // DashboardCacheManager: INTERVALO_MS/comentário). O orçamento de retry
  // precisa ultrapassar esse tempo, senão o front desiste antes do cache ficar
  // pronto e mostra "cache-warming" indevidamente. 70 x 8s = ~9,3 min de folga.
  const MAX_TRIES = 70, WAIT_MS = 8000;
  for (let tentativa = 1; tentativa <= MAX_TRIES; tentativa++) {
    try {
      const res = await fetch(`${API_BASE_URL}/full`);
      if (res.status === 503) throw new Error('cache-warming');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || typeof data !== 'object') throw new Error('payload inválido');
      window.REAL_DATA = data;
      
      // Aplicar Trava de Acesso Rígida (nomes resolvidos p/ chaves canônicas do cubo)
      applyAccessLock();

      // Espera o recorte do escopo do usuário ANTES de renderizar: sem ele as abas
      // cairiam no cubo da empresa por alguns segundos.
      if (activeFilterCount() > 0){
        if (txt) txt.textContent = 'Aplicando o seu escopo de acesso…';
        await ensureCliScope();
      }

      break;
    } catch (e) {
      const warming = (e.message === 'cache-warming');
      if (warming && tentativa < MAX_TRIES) {
        if (txt) {
          const decorrido = Math.round((tentativa * WAIT_MS) / 60000 * 10) / 10;
          txt.textContent = `Preparando os dados no servidor… (${decorrido} min — a primeira carga leva ~6-7 min)`;
        }
        await new Promise(r => setTimeout(r, WAIT_MS));
        continue;
      }
      console.error('Erro ao puxar dados da API:', e);
      if (errBox) {
        errBox.textContent = warming
          ? `A API ainda está montando os dados. Aguarde e recarregue a página.`
          : `Falha ao carregar dados da API (${API_BASE_URL}). A API está rodando na porta 4001? Detalhe: ${e.message}`;
        errBox.style.display = 'block';
      }
      if (overlay) overlay.style.display = 'none';
      return;
    }
  }
  if (overlay) overlay.style.display = 'none';
  const btn = document.getElementById('themeTog'); if (btn) btn.textContent = (currentTheme()==='dark' ? '☀️' : '🌙');
  applyChartTheme();
  init();
}

loadAndInit();

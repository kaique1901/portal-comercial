// ── APRESENTAÇÃO EXECUTIVA ──────────────────────────────────────────────────
// Gera um deck (PPTX + HTML navegável) para reunião de diretoria a partir dos
// dados JÁ CARREGADOS no portal — 100% no navegador, sem chamada de rede nova
// e sem depender de nenhuma IA em produção.
//
// Arquitetura (ver plano): cada aba tem um "extractor" que reaproveita as
// funções/variáveis que a aba já usa pra renderizar (nunca recalcula nada do
// zero) e devolve um objeto simples ("slide spec"). Um motor genérico
// (apexSplitTable) divide tabelas densas em partes legíveis, sempre repetindo
// a coluna de nome/categoria. Dois renderizadores (PPTX via PptxGenJS e HTML
// autocontido) consomem exatamente o mesmo "slide spec" — por isso os dois
// formatos saem sempre com o mesmo conteúdo.
//
// Este arquivo não toca nada do app.js além de LER globals que já existem
// (REAL_DATA, ST, curPeriod(), buildCategoriaTable(), etc.) — nenhuma aba
// existente muda de comportamento por causa disto.

// ── Paleta (hex cru — PPTX/HTML não leem var(--...) do style.css) ─────────
const APEX_COLORS = {
  bg:'FFFFFF', bg2:'EAEFEC', bg3:'DDE5E0',
  t1:'10241A', t2:'52685C', t3:'85978C',
  acc:'1F7A52', acc2:'2F9468', acc3:'0D5C3A',
  up:'22875A', dn:'B3261E', amb:'A3763A',
  sbBg:'0E2A1C',
};

// Teto de linhas "de negócio" por tabela de ranking longo (Vendedores Abaixo
// da Meta / Produtos Parados / Letra P) — a lista COMPLETA já existe na aba
// original do portal; o slide de diretoria mostra só o topo que importa pra
// discussão, com nota indicando quantos ficaram de fora. Diferente do limite
// de linhas do apexSplitTable (que pagina tabelas médias em partes), aqui é
// um corte editorial pra não virar 15-20 slides de uma tabela só.
const APEX_TOPN_TABELA = 20;

// ── Utilitário de comparação (mesmo racional de deltaPillSmall, sem HTML) ──
function apexDeltaTxt(cur, prev){
  if (cur==null || prev==null) return { texto:'sem histórico', bom:null };
  if (prev===0) return { texto:'—', bom:null };
  const d = (cur-prev)/prev*100;
  return { texto: `${d>=0?'▲':'▼'} ${Math.abs(d).toFixed(1)}%`, bom: d>=0 };
}

// Escopo/período ativo AGORA (mesmo texto que o badge do topo do portal já
// mostra) — todo slide carrega isso, pra nunca aparecer número sem dizer de
// onde veio.
function apexContextoAtivo(){
  const d = (typeof curPeriod==='function') ? curPeriod() : null;
  const level = (typeof hierLevelActive==='function') ? hierLevelActive() : null;
  const names = level && typeof hierSelectedNames==='function' ? hierSelectedNames(level) : [];
  const escopoLabel = level ? `${level[0].toUpperCase()+level.slice(1)}: ${labelJoin(names)}` : 'Empresa inteira';
  const periodoLabel = (d && d.label) ? d.label : (typeof ST!=='undefined'?ST.per:'—');
  return { escopoLabel, periodoLabel };
}

// ── Divisão de tabelas densas ────────────────────────────────────────────
// Sempre repete a coluna 0 (nome/categoria) em toda parte — é a "referência
// de categoria" que não pode se perder quando a tabela não cabe num slide só.
function apexSplitTable(table, opts){
  opts = opts || {};
  const maxCols = opts.maxCols || 6;   // colunas de DADO por parte (exclui a coluna 0)
  const maxRows = opts.maxRows || 12;
  const headers = table.headers, rows = table.rows;
  const dataCols = headers.length - 1;
  const nColParts = Math.max(1, Math.ceil(dataCols / maxCols));
  const nRowParts = Math.max(1, Math.ceil(rows.length / maxRows));
  const partes = [];
  const totalPartes = nColParts * nRowParts;
  for (let rp=0; rp<nRowParts; rp++){
    const rowSlice = rows.slice(rp*maxRows, (rp+1)*maxRows);
    for (let cp=0; cp<nColParts; cp++){
      const colStart = 1 + cp*maxCols, colEnd = Math.min(headers.length, colStart+maxCols);
      const hdr = [headers[0]].concat(headers.slice(colStart, colEnd));
      const rws = rowSlice.map(r => [r[0]].concat(r.slice(colStart, colEnd)));
      const parteIdx = rp*nColParts + cp + 1;
      const sufixo = totalPartes>1 ? ` — Parte ${parteIdx}/${totalPartes}` : '';
      partes.push({ titulo: table.titulo + sufixo, headers: hdr, rows: rws });
    }
  }
  return partes;
}

// ═══════════════════════════════════════════════════════════════════════
// EXTRACTORS — um por aba. Cada um só LÊ dados já calculados pelas próprias
// funções de render da aba (ou por helpers puros que elas já usam) e devolve
// { tabKey, tabLabel, scopeLabel, kpis, tables, ranking, notas }.
// Devolver `null` = aba pulada no deck (sem dado disponível agora).
// ═══════════════════════════════════════════════════════════════════════

function apexExtractObjetivos(){
  if (typeof OBJ !== 'undefined' && OBJ.modo === 'datas') return null; // modo sem Meta/Tendência
  const d = curPeriod(), prev = prevPeriod();
  if (!d || !d.meta) return null;
  const meses = objMesesSelecionados();
  if (!meses.length) return null;
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  const built = buildCategoriaTable(d, prev, meses, level, names);
  const scopeLabel = level ? `${level[0].toUpperCase()+level.slice(1)}: ${labelJoin(names)}` : 'Empresa inteira';
  const prevTotalCash = (built.prevTotalRealCat!=null && built.prevTotalCustoCat!=null) ? (built.prevTotalRealCat-built.prevTotalCustoCat) : null;

  const kpis = [
    { label:'Meta Geral', value: fF(built.totalMetaCat) },
    { label:'Realizado', value: fF(built.totalRealCat) },
    { label:'Tendência de Fechamento', value: fF(built.totalTrend), delta: apexDeltaTxt(built.totalTrend, built.prevTotalRealCat) },
    { label:'Cash Margem (Tendência)', value: fF(built.totalTrendCash), delta: apexDeltaTxt(built.totalTrendCash, prevTotalCash) },
    { label:'Margem %', value: built.totalMargemGeral!=null?fPct(built.totalMargemGeral):'—' },
    { label:'Positivação', value: built.totalNCli!=null?fN(built.totalNCli):'—', delta: apexDeltaTxt(built.totalNCli, built.prevTotalNCli) },
    { label:'Estoque Box', value: built.totalEstoqueBox!=null?fF(built.totalEstoqueBox):'—' },
  ];

  const cats = built.catRowsData || [];
  const ranking = cats.length ? { titulo:'Top Categorias por Realizado', items: cats.slice().sort((a,b)=>b.real-a.real).slice(0,5).map(c=>({label:c.nome, value:c.real})) } : null;

  const tables = cats.length ? [
    { titulo:'Faturamento por Categoria', headers:['Categoria','Meta','Realizado','Tendência','Ano Anterior','Δ Tend. vs Ano Ant.'],
      rows: cats.map(c=>[c.nome, fF(c.meta), fF(c.real), fF(c.trend), c.prevReal!=null?fF(c.prevReal):'sem base', apexDeltaTxt(c.trend,c.prevReal).texto]) },
    { titulo:'Cash Margem por Categoria', headers:['Categoria','Meta Cash Margem','Cash Margem','Tendência Cash Margem','Ano Anterior','Δ vs Ano Ant.'],
      rows: cats.map(c=>[c.nome, c.metaCash>0?fF(c.metaCash):'—', fF(c.cash), fF(c.trendCash), c.prevCash!=null?fF(c.prevCash):'sem base', apexDeltaTxt(c.trendCash,c.prevCash).texto]) },
    { titulo:'Margem % e Positivação por Categoria', headers:['Categoria','Margem %','Positivação','Positivação Ano Ant.','Δ Positivação'],
      rows: cats.map(c=>[c.nome, c.margem!=null?fPct(c.margem):'—', c.nCliCat!=null?fN(c.nCliCat):'—', c.prevNCliCat!=null?fN(c.prevNCliCat):'—', apexDeltaTxt(c.nCliCat,c.prevNCliCat).texto]) },
  ] : [];

  return { tabKey:'obj', tabLabel:'Acompanhamento Objetivos', scopeLabel, kpis, tables, ranking, notas: built.realCatMonthNote?[built.realCatMonthNote]:[] };
}

function apexExtractMargemCash(){
  const res = renderMargemCash();
  if (!res) return null;
  const kpis = [
    { label:'Faturamento', value: fF(res.effR), delta: apexDeltaTxt(res.effR, res.prevEffR) },
    { label:'Cash Margem Total', value: fF(res.cash), delta: apexDeltaTxt(res.cash, res.prevCash) },
    { label:'Tendência Cash Margem', value: fF(res.trendCash) },
    { label:'Margem %', value: fPct(res.effM), delta: apexDeltaTxt(res.trendM, res.prevM) },
    { label:'Meta Margem %', value: res.metaMargemPct>0?fPct(res.metaMargemPct):'—' },
  ];
  const catRows = res.catRows||[];
  const ranking = catRows.length ? { titulo:'Top Categorias por Cash Margem', items: catRows.slice().sort((a,b)=>(b.r-b.c)-(a.r-a.c)).slice(0,5).map(c=>({label:c.nome, value:c.r-c.c})) } : null;
  const tables = catRows.length ? [{ titulo:'Cash Margem por Categoria', headers:['Categoria','Faturamento','Cash Margem','Margem %'],
    rows: catRows.map(c=>[c.nome, fF(c.r), fF(c.r-c.c), fPct(c.m)]) }] : [];
  return { tabKey:'mc', tabLabel:'Margem & Cash Margem', scopeLabel: apexContextoAtivo().escopoLabel, kpis, tables, ranking, notas:[] };
}

function apexExtractMix(){
  const res = renderMix();
  if (!res) return null;
  const clientes = res.clientes || [];
  const mediaPositivacao = clientes.length ? clientes.reduce((s,c)=>s+c.positivacaoPct,0)/clientes.length : null;
  const mediaCategorias = clientes.length ? clientes.reduce((s,c)=>s+c.categorias,0)/clientes.length : null;
  const kpis = [
    { label:'Clientes no Top 25', value: fN(clientes.length) },
    { label:'Positivação média (Top 25)', value: mediaPositivacao!=null?mediaPositivacao.toFixed(0)+'%':'—' },
    { label:'Categorias distintas/cliente (média)', value: mediaCategorias!=null?`${mediaCategorias.toFixed(1)} de ${res.nCatTotal}`:'—' },
  ];
  const ranking = clientes.length ? { titulo:'Top 5 Clientes por Receita', items: clientes.slice(0,5).map(c=>({label:c.nome, value:c.receita})) } : null;
  const tables = clientes.length ? [{ titulo:'Top Clientes — Mix & Positivação', headers:['Cliente','Receita','Δ vs Ano Ant.','Categorias','Meses Ativos','Positivação'],
    rows: clientes.slice(0,15).map(c=>[c.nome, fF(c.receita), apexDeltaTxt(c.receita,c.prevReceita).texto, `${c.categorias} de ${res.nCatTotal}`, `${c.mesesAtivos} de ${c.nMeses}`, c.positivacaoPct+'%']) }] : [];
  return { tabKey:'mix', tabLabel:'Mix & Positivação', scopeLabel: res.scopeLabel || 'Empresa inteira', kpis, tables, ranking,
    notas:['Positivação aqui é proxy de meses ativos no período (não é a mesma fonte/metodologia de Acompanhamento Objetivos).'] };
}

function apexExtractKgFumo(){
  const res = renderMetasExtra();
  if (!res) return null;
  const kpis = [
    { label:'KG Fumo — Tendência', value: fN(res.kg.tend)+' kg', delta: apexDeltaTxt(res.kg.tend, res.kg.prevReal) },
    { label:'Papel — Tendência', value: fN(res.papel.tend), delta: apexDeltaTxt(res.papel.tend, res.papel.prevReal) },
    { label:'Produto Estratégico — Tendência', value: fF(res.estrategico.tend), delta: apexDeltaTxt(res.estrategico.tend, res.estrategico.prevReal) },
  ];
  const tables = [{ titulo:'KG Fumo / Papel / Estratégico — Meta x Tendência x Ano Anterior', headers:['Indicador','Meta','Realizado','Tendência','Ano Anterior','Δ Tend. vs Ano Ant.'],
    rows: [
      ['KG Fumo', fN(res.kg.meta)+' kg', fN(res.kg.real)+' kg', fN(res.kg.tend)+' kg', res.kg.prevReal!=null?fN(res.kg.prevReal)+' kg':'sem base', apexDeltaTxt(res.kg.tend,res.kg.prevReal).texto],
      ['Papel', fN(res.papel.meta), fN(res.papel.real), fN(res.papel.tend), res.papel.prevReal!=null?fN(res.papel.prevReal):'sem base', apexDeltaTxt(res.papel.tend,res.papel.prevReal).texto],
      ['Produto Estratégico', fF(res.estrategico.meta), fF(res.estrategico.real), fF(res.estrategico.tend), res.estrategico.prevReal!=null?fF(res.estrategico.prevReal):'sem base', apexDeltaTxt(res.estrategico.tend,res.estrategico.prevReal).texto],
    ] }];
  return { tabKey:'kgfumo', tabLabel:'KG Fumo, Papel e Estratégico', scopeLabel: res.scopeLabel || 'Empresa inteira', kpis, tables, ranking:null, notas:[] };
}

function apexExtractVendedoresMeta(){
  const ano = anoVigente();
  const d = buildYearPeriod(ano);
  if (!d) return null;
  const fechados = mesesFechadosDoAno(d, ano);
  if (!fechados.length) return null;
  const escopo = vendedoresParaPlano(d);
  const stats = escopo.map(v => Object.assign({}, v, { stats: vendedorEstatMensal(d, v.nome, ano) }));
  const comVenda = stats.filter(v => v.stats.mesesAtivos > 0);
  const mediaEmpresa = comVenda.length ? comVenda.reduce((s,v)=>s+v.stats.media,0) / comVenda.length : 0;
  const grupo1 = stats.filter(v => v.stats.media < LIMIAR_VEND_1).sort((a,b)=>a.stats.media-b.stats.media);
  const grupo2 = stats.filter(v => v.stats.media >= LIMIAR_VEND_1 && v.stats.media <= LIMIAR_VEND_2).sort((a,b)=>a.stats.media-b.stats.media);
  const desligados = (typeof vendedoresDesligadosNoEscopo==='function') ? vendedoresDesligadosNoEscopo(d) : [];
  const level = hierLevelActive();

  const kpis = [
    { label:'Vendedores no escopo', value: fN(escopo.length) },
    { label:'Abaixo de R$150 mil/mês', value: fN(grupo1.length) },
    { label:'Entre R$150 mil e R$200 mil/mês', value: fN(grupo2.length) },
    { label:'Média da empresa', value: fF(mediaEmpresa) },
  ];
  const piorLista = stats.slice().sort((a,b)=>a.stats.media-b.stats.media).slice(0,5);
  const ranking = piorLista.length ? { titulo:'5 Vendedores com Menor Média Mensal', items: piorLista.map(v=>({label:v.nome, value:v.stats.media})) } : null;
  // Slide de diretoria não é a tabela completa do portal (pode ter 100+
  // vendedores) — mostra os N piores por média (o que interessa discutir na
  // reunião) e avisa quantos ficaram de fora, em vez de despejar tudo em
  // dezenas de slides.
  const abaixoMeta = grupo1.concat(grupo2).sort((a,b)=>a.stats.media-b.stats.media);
  const abaixoMetaTop = abaixoMeta.slice(0, APEX_TOPN_TABELA);
  const tables = abaixoMetaTop.length ? [{ titulo:`Vendedores Abaixo da Meta (${abaixoMetaTop.length} de ${abaixoMeta.length}, piores médias)`, headers:['Vendedor','Supervisor','Média Mensal','Meses Ativos'],
    rows: abaixoMetaTop.map(v=>[v.nome, v.supervisor||'—', fF(v.stats.media), `${v.stats.mesesAtivos} de ${v.stats.nMesesFechados}`]) }] : [];
  const notas = [];
  if (abaixoMeta.length > abaixoMetaTop.length) notas.push(`Lista completa (${abaixoMeta.length} vendedores) disponível na aba "Vendedores Abaixo da Meta" do portal.`);
  if (desligados.length) notas.push(`${desligados.length} vendedor(es) desligado(s) da empresa foram excluídos desta análise.`);
  return { tabKey:'vendmeta', tabLabel:'Vendedores Abaixo da Meta',
    scopeLabel: level ? `${level[0].toUpperCase()+level.slice(1)}: ${labelJoin(hierSelectedNames(level))}` : 'Empresa inteira',
    kpis, tables, ranking, notas };
}

function apexExtractEstoque(){
  const est = REAL_DATA._estoque;
  if (!est) return null;
  const diasUteis = est.dias_uteis_90 || 0;
  const rows = estoqueFilterRows(est);
  const geral = computeEstoqueDOS(rows, diasUteis);
  const produtos90 = computeProdutosParados(rows, diasUteis);
  const kpis = [
    { label:'Valor de Estoque', value: fF(geral.valorTotal) },
    { label:'Cobertura Média', value: geral.dos!=null?fN(geral.dos)+' dias':'sem venda 90d' },
    { label:'Itens c/ cobertura > 90 dias', value: `${fN(produtos90.length)} de ${fN(rows.length)}` },
  ];
  const treeCat = buildEstoqueCascadeTree(rows, ['categoria'], 0, diasUteis);
  const catEntries = Object.keys(treeCat).map(k=>Object.assign({nome:k}, treeCat[k])).sort((a,b)=>b.valorTotal-a.valorTotal);
  const ranking = catEntries.length ? { titulo:'Top 5 Categorias por Valor em Estoque', items: catEntries.slice(0,5).map(c=>({label:c.nome, value:c.valorTotal})) } : null;
  const tables = catEntries.length ? [{ titulo:'Estoque por Categoria', headers:['Categoria','Valor Estoque','Unidades','Cobertura (dias)'],
    rows: catEntries.map(c=>[c.nome, fF(c.valorTotal), fN(c.saldoTotal), c.dos!=null?fN(c.dos):'sem venda 90d']) }] : [];
  return { tabKey:'estoque', tabLabel:'Estoque x Venda (90 dias)', scopeLabel: apexContextoAtivo().escopoLabel, kpis, tables, ranking, notas:[] };
}

function apexExtractProdutosParadosVend(){
  const est = REAL_DATA._estoque;
  if (!est) return null;
  const diasUteis = est.dias_uteis_90 || 0;
  const rows = estoqueFilterRows(est);
  const parados = computeProdutosParados(rows, diasUteis);
  const treeVend = buildEstoqueParadosCascadeTree(parados, ['vendedor'], 0);
  const vendEntries = Object.keys(treeVend).map(k=>Object.assign({nome:k}, treeVend[k])).sort((a,b)=>b.valorTotal-a.valorTotal);
  const semVenda = vendEntries.filter(v=>v.hasNeverSold).length;
  const kpis = [
    { label:'Itens parados (vend.×produto)', value: fN(parados.length) },
    { label:'Valor parado total', value: fF(vendEntries.reduce((s,v)=>s+v.valorTotal,0)) },
    { label:'Vendedores com itens sem giro 90d', value: fN(semVenda) },
  ];
  const ranking = vendEntries.length ? { titulo:'Top 5 Vendedores por Valor Parado', items: vendEntries.slice(0,5).map(v=>({label:v.nome, value:v.valorTotal})) } : null;
  const topEntries = vendEntries.slice(0, APEX_TOPN_TABELA);
  const tables = topEntries.length ? [{ titulo:`Produtos Parados por Vendedor (${topEntries.length} de ${vendEntries.length}, maior valor parado)`, headers:['Vendedor','Valor Parado','Unidades Paradas','Itens','Pior Cobertura'],
    rows: topEntries.map(v=>[v.nome, fF(v.valorTotal), fN(v.saldoTotal), fN(v.nItens), v.hasNeverSold?'sem venda 90d':(v.worstDos!=null?fN(v.worstDos)+' dias':'—')]) }] : [];
  const notas = vendEntries.length > topEntries.length ? [`Lista completa (${vendEntries.length} vendedores) disponível na aba "Produtos Parados por Vendedor" do portal.`] : [];
  return { tabKey:'paradosvend', tabLabel:'Produtos Parados por Vendedor', scopeLabel: apexContextoAtivo().escopoLabel, kpis, tables, ranking, notas };
}

function apexExtractProdutosLetraP(){
  const est = REAL_DATA._estoque;
  if (!est) return null;
  const rows = estoqueFilterRows(est).filter(r=>/^\(P\)/i.test((r.descricao||'').trim()));
  const treeVend = buildEstoqueParadosCascadeTree(rows, ['vendedor'], 0);
  const vendEntries = Object.keys(treeVend).map(k=>Object.assign({nome:k}, treeVend[k])).sort((a,b)=>b.valorTotal-a.valorTotal);
  const kpis = [
    { label:'Itens "(P)" (vend.×produto)', value: fN(rows.length) },
    { label:'Valor em estoque "(P)"', value: fF(vendEntries.reduce((s,v)=>s+v.valorTotal,0)) },
  ];
  const ranking = vendEntries.length ? { titulo:'Top 5 Vendedores — Estoque "(P)"', items: vendEntries.slice(0,5).map(v=>({label:v.nome, value:v.valorTotal})) } : null;
  const topEntries = vendEntries.slice(0, APEX_TOPN_TABELA);
  const tables = topEntries.length ? [{ titulo:`Produtos Letra P por Vendedor (${topEntries.length} de ${vendEntries.length}, maior valor)`, headers:['Vendedor','Valor em Estoque','Unidades','Itens'],
    rows: topEntries.map(v=>[v.nome, fF(v.valorTotal), fN(v.saldoTotal), fN(v.nItens)]) }] : [];
  const notas = vendEntries.length > topEntries.length ? [`Lista completa (${vendEntries.length} vendedores) disponível na aba "Produtos Letra P" do portal.`] : [];
  return { tabKey:'letrap', tabLabel:'Produtos Letra P', scopeLabel: apexContextoAtivo().escopoLabel, kpis, tables, ranking, notas };
}

// Registro central — adicionar uma aba nova no futuro é só empurrar 1 item
// aqui (a UI de checklist e o motor de slides são genéricos).
const APEX_TABS = [
  { key:'obj', label:'Acompanhamento Objetivos', desc:'Meta x Realizado x Tendência x Margem x Positivação por categoria.', extractor: apexExtractObjetivos },
  { key:'mc', label:'Margem & Cash Margem', desc:'Cash Margem total, tendência de fechamento e ranking por categoria.', extractor: apexExtractMargemCash },
  { key:'mix', label:'Mix & Positivação', desc:'Top clientes por receita, categorias distintas e positivação.', extractor: apexExtractMix },
  { key:'kgfumo', label:'KG Fumo, Papel e Estratégico', desc:'Meta x tendência x ano anterior das 3 métricas especiais.', extractor: apexExtractKgFumo },
  { key:'vendmeta', label:'Vendedores Abaixo da Meta', desc:'Vendedores abaixo do piso de R$150 mil/R$200 mil por mês.', extractor: apexExtractVendedoresMeta },
  { key:'estoque', label:'Estoque x Venda (90 dias)', desc:'Valor de estoque, cobertura média e ranking por categoria.', extractor: apexExtractEstoque },
  { key:'paradosvend', label:'Produtos Parados por Vendedor', desc:'Valor parado (>90 dias de cobertura) por vendedor.', extractor: apexExtractProdutosParadosVend },
  { key:'letrap', label:'Produtos Letra P', desc:'Estoque de produtos com descrição "(P)" por vendedor.', extractor: apexExtractProdutosLetraP },
];

// ═══════════════════════════════════════════════════════════════════════
// MONTAGEM DO DECK — transforma os specs das abas selecionadas numa lista
// plana de slides já numerada (capa → agenda → resumo+tabelas de cada aba →
// fechamento).
// ═══════════════════════════════════════════════════════════════════════
function apexBuildDeck(selectedKeys, tituloReuniao){
  const { escopoLabel, periodoLabel } = apexContextoAtivo();
  const geradoEm = new Date().toLocaleString('pt-BR');
  const titulo = (tituloReuniao && tituloReuniao.trim()) || `Resultados Comerciais — ${periodoLabel}`;

  const specs = [];
  selectedKeys.forEach(key=>{
    const tab = APEX_TABS.find(t=>t.key===key);
    if (!tab) return;
    let spec = null;
    try { spec = tab.extractor(); } catch(e){ console.error('[apresentacao] extractor falhou p/ '+key, e); }
    if (spec) specs.push(spec);
  });

  const slides = [];
  slides.push({ kind:'capa', titulo, escopoLabel, periodoLabel, geradoEm });
  slides.push({ kind:'agenda', titulo:'Agenda', itens: specs.map(s=>s.tabLabel) });
  specs.forEach(spec=>{
    slides.push({ kind:'resumo', tabLabel:spec.tabLabel, titulo:spec.tabLabel, scopeLabel:spec.scopeLabel, kpis:spec.kpis, ranking:spec.ranking, notas:spec.notas });
    (spec.tables||[]).forEach(table=>{
      apexSplitTable(table).forEach(parte=>{
        slides.push({ kind:'tabela', tabLabel:spec.tabLabel, titulo:parte.titulo, headers:parte.headers, rows:parte.rows, scopeLabel:spec.scopeLabel });
      });
    });
  });
  slides.push({ kind:'fechamento', titulo:'Próximos Passos', placeholders:['Destaque do período', 'Ponto de atenção', 'Ação recomendada'] });

  const pageTotal = slides.length;
  slides.forEach((s,i)=>{ s.pageIdx = i+1; s.pageTotal = pageTotal; });
  return { titulo, periodoLabel, escopoLabel, geradoEm, slides, abasIncluidas: specs.map(s=>s.tabLabel) };
}

// ═══════════════════════════════════════════════════════════════════════
// RENDERIZADOR PPTX (PptxGenJS, vendorizado em public/js/pptxgen.bundle.js)
// ═══════════════════════════════════════════════════════════════════════
function apexPptxChrome(slide, s){
  slide.background = { color: APEX_COLORS.bg };
  slide.addText('Portal Comercial — Resultados Comerciais', { x:0.4, y:0.12, w:8, h:0.3, fontSize:9, color:APEX_COLORS.t3 });
  slide.addText(`${s.pageIdx} / ${s.pageTotal}`, { x:12.2, y:0.12, w:0.7, h:0.3, fontSize:9, color:APEX_COLORS.t3, align:'right' });
  if (s.scopeLabel){
    slide.addText(s.scopeLabel, { x:0.4, y:7.1, w:10, h:0.3, fontSize:9, color:APEX_COLORS.t3 });
  }
}
async function apexBuildPptx(deck){
  const pres = new window.PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.author = 'Portal Comercial'; pres.company = 'Cifal'; pres.title = deck.titulo;

  deck.slides.forEach(s=>{
    const slide = pres.addSlide();
    apexPptxChrome(slide, s);

    if (s.kind === 'capa'){
      slide.addText(s.titulo, { x:0.6, y:2.5, w:12.1, h:1.3, fontSize:32, bold:true, color:APEX_COLORS.t1 });
      slide.addText(`Escopo: ${s.escopoLabel}   ·   Período: ${s.periodoLabel}`, { x:0.6, y:3.85, w:12.1, h:0.5, fontSize:16, color:APEX_COLORS.t2 });
      slide.addText(`Gerado em ${s.geradoEm}`, { x:0.6, y:4.35, w:12.1, h:0.4, fontSize:12, color:APEX_COLORS.t3 });

    } else if (s.kind === 'agenda'){
      slide.addText(s.titulo, { x:0.6, y:0.55, w:12.1, h:0.6, fontSize:24, bold:true, color:APEX_COLORS.acc3 });
      s.itens.forEach((it,i)=>{
        slide.addText(`•  ${it}`, { x:0.9, y:1.5+i*0.5, w:11.3, h:0.45, fontSize:16, color:APEX_COLORS.t2 });
      });

    } else if (s.kind === 'resumo'){
      slide.addText(s.titulo, { x:0.6, y:0.5, w:12.1, h:0.5, fontSize:22, bold:true, color:APEX_COLORS.acc3 });
      const kpis = s.kpis || [];
      const cols = Math.min(4, kpis.length) || 1;
      const cardW = 12.1/cols - 0.12;
      kpis.forEach((k,i)=>{
        const col = i % cols, row = Math.floor(i/cols);
        const x = 0.6 + col*(cardW+0.12), y = 1.2 + row*1.1;
        slide.addShape(pres.ShapeType.roundRect, { x, y, w:cardW, h:0.95, fill:{color:APEX_COLORS.bg2}, line:{type:'none'}, rectRadius:0.06 });
        slide.addText(k.label, { x:x+0.12, y:y+0.08, w:cardW-0.24, h:0.3, fontSize:10, color:APEX_COLORS.t3 });
        slide.addText(String(k.value), { x:x+0.12, y:y+0.34, w:cardW-0.24, h:0.38, fontSize:16, bold:true, color:APEX_COLORS.t1 });
        if (k.delta && k.delta.texto){
          slide.addText(k.delta.texto, { x:x+0.12, y:y+0.7, w:cardW-0.24, h:0.22, fontSize:10,
            color: k.delta.bom===true?APEX_COLORS.up:k.delta.bom===false?APEX_COLORS.dn:APEX_COLORS.t3 });
        }
      });
      const kpiRows = Math.ceil(kpis.length/cols) || 0;
      let y = 1.2 + kpiRows*1.1 + 0.15;
      if (s.ranking && s.ranking.items && s.ranking.items.length){
        const chartData = [{ name: s.ranking.titulo, labels: s.ranking.items.map(it=>String(it.label)), values: s.ranking.items.map(it=>Math.round(it.value)) }];
        const chartH = Math.max(1.8, 6.85 - y - (s.notas&&s.notas.length?0.4:0));
        slide.addText(s.ranking.titulo, { x:0.6, y, w:12.1, h:0.3, fontSize:12, bold:true, color:APEX_COLORS.t2 });
        slide.addChart(pres.ChartType.bar, chartData, { x:0.6, y:y+0.32, w:11.9, h:chartH-0.32, barDir:'bar', showValue:true, chartColors:[APEX_COLORS.acc], showLegend:false });
      }
      if (s.notas && s.notas.length){
        slide.addText(s.notas.join(' '), { x:0.6, y:6.7, w:12.1, h:0.35, fontSize:9, italic:true, color:APEX_COLORS.t3 });
      }

    } else if (s.kind === 'tabela'){
      slide.addText(s.titulo, { x:0.6, y:0.5, w:12.1, h:0.5, fontSize:19, bold:true, color:APEX_COLORS.t1 });
      const nCols = s.headers.length;
      const fontSize = nCols<=4?12:nCols<=6?11:10;
      const headerRow = s.headers.map(h=>({ text:h, options:{ bold:true, fill:{color:APEX_COLORS.acc}, color:'FFFFFF', fontSize } }));
      const bodyRows = s.rows.map(r=>r.map(cell=>({ text:String(cell), options:{ fontSize } })));
      slide.addTable([headerRow].concat(bodyRows), { x:0.4, y:1.15, w:12.5, fontSize, border:{type:'solid', color:APEX_COLORS.bg3, pt:0.5}, autoPage:false });

    } else if (s.kind === 'fechamento'){
      slide.addText(s.titulo, { x:0.6, y:0.6, w:12.1, h:0.6, fontSize:24, bold:true, color:APEX_COLORS.acc3 });
      (s.placeholders||[]).forEach((p,i)=>{
        slide.addText(`▸ ${p}:`, { x:0.9, y:1.6+i*1.0, w:11.3, h:0.4, fontSize:14, bold:true, color:APEX_COLORS.t2 });
        slide.addShape(pres.ShapeType.line, { x:0.9, y:2.05+i*1.0, w:9.5, h:0, line:{color:APEX_COLORS.t3, width:0.75, dashType:'dash'} });
      });
    }
  });

  const fileName = (deck.titulo||'apresentacao').replace(/[^\w\- ]+/g,'').trim() || 'apresentacao';
  await pres.writeFile({ fileName: fileName + '.pptx' });
}

// ═══════════════════════════════════════════════════════════════════════
// RENDERIZADOR HTML (slideshow autocontido — mesmo conteúdo do PPTX)
// ═══════════════════════════════════════════════════════════════════════
const APEX_HTML_CSS = `
:root{--bg:#ffffff;--bg2:#eaefec;--bg3:#dde5e0;--t1:#10241a;--t2:#52685c;--t3:#85978c;--acc:#1f7a52;--acc3:#0d5c3a;--up:#22875a;--dn:#b3261e;--bdr:rgba(16,36,26,.10)}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0e2a1c;font-family:'Segoe UI',system-ui,sans-serif}
.apex-slide{display:none;position:relative;width:100vw;height:100vh;background:var(--bg);color:var(--t1);padding:34px 48px 46px;overflow:auto}
.apex-slide.active{display:flex;flex-direction:column}
.apex-chrome-top{display:flex;justify-content:space-between;font-size:11px;color:var(--t3);margin-bottom:16px;flex-shrink:0}
.apex-chrome-bottom{position:absolute;left:48px;bottom:14px;font-size:10px;color:var(--t3)}
.apex-body{flex:1;overflow:auto;min-height:0}
h1{font-size:clamp(22px,3.2vw,38px);margin:36px 0 8px}
h2{font-size:clamp(17px,2.2vw,26px);color:var(--acc3);margin:0 0 18px}
.apex-sub{font-size:clamp(12px,1.4vw,18px);color:var(--t2)}
.apex-meta{font-size:11px;color:var(--t3)}
.apex-agenda{font-size:clamp(13px,1.6vw,18px);line-height:2.1;color:var(--t2);list-style:none;padding:0;margin:0}
.apex-kpigrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:22px;flex-shrink:0}
.apex-kpi{background:var(--bg2);border-radius:10px;padding:12px 14px}
.apex-kpi-lbl{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.3px}
.apex-kpi-val{font-size:clamp(15px,1.8vw,21px);font-weight:700;margin-top:4px;word-break:break-word}
.apex-kpi-delta{font-size:11px;margin-top:4px;color:var(--t3)}
.apex-kpi-delta.up{color:var(--up)} .apex-kpi-delta.dn{color:var(--dn)}
.apex-rank{margin-top:4px}
.apex-rank-title{font-size:12px;color:var(--t2);margin-bottom:10px;font-weight:600}
.apex-rank-row{display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12px}
.apex-rank-lbl{width:200px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.apex-rank-bar-bg{flex:1;height:12px;background:var(--bg2);border-radius:6px;overflow:hidden}
.apex-rank-bar-fg{height:100%;background:var(--acc)}
.apex-rank-val{width:100px;text-align:right;flex-shrink:0}
.apex-nota{font-size:10.5px;color:var(--t3);margin-top:14px;font-style:italic}
.apex-tbl-wrap{overflow:auto;flex:1;min-height:0}
.apex-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.apex-tbl th{background:var(--acc);color:#fff;padding:6px 9px;text-align:left;position:sticky;top:0;white-space:nowrap}
.apex-tbl td{padding:5px 9px;border-bottom:1px solid var(--bdr);white-space:nowrap}
.apex-tbl tr:nth-child(even) td{background:rgba(31,122,82,.04)}
.apex-placeholder{font-size:14px;color:var(--t2);margin:12px 0}
.apex-fill{display:inline-block;border-bottom:1px solid var(--t3);width:300px;margin-left:6px}
.apex-nav{position:fixed;bottom:12px;right:18px;z-index:10;display:flex;align-items:center;gap:8px;background:rgba(14,42,28,.85);padding:5px 10px;border-radius:18px}
.apex-nav button{background:none;border:none;color:#eef5f0;font-size:18px;cursor:pointer;padding:2px 8px;line-height:1}
.apex-nav button:hover{color:#4fd497}
#apexCounter{color:#a8c2b1;font-size:11px;min-width:40px;text-align:center}
@media print{.apex-nav{display:none}.apex-slide{display:flex !important;page-break-after:always}}
`;
const APEX_HTML_JS = `
(function(){
  var slides = document.querySelectorAll('.apex-slide');
  var idx = 0;
  function show(i){
    idx = Math.max(0, Math.min(slides.length-1, i));
    for (var j=0;j<slides.length;j++) slides[j].classList.toggle('active', j===idx);
    document.getElementById('apexCounter').textContent = (idx+1)+' / '+slides.length;
  }
  document.getElementById('apexPrev').onclick = function(){ show(idx-1); };
  document.getElementById('apexNext').onclick = function(){ show(idx+1); };
  document.addEventListener('keydown', function(e){
    if (e.key==='ArrowRight' || e.key===' ') show(idx+1);
    if (e.key==='ArrowLeft') show(idx-1);
  });
  show(0);
})();
`;
function apexEsc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function apexSlideHtml(s){
  let inner = '';
  if (s.kind==='capa'){
    inner = `<h1>${apexEsc(s.titulo)}</h1><p class="apex-sub">Escopo: <b>${apexEsc(s.escopoLabel)}</b> · Período: <b>${apexEsc(s.periodoLabel)}</b></p><p class="apex-meta">Gerado em ${apexEsc(s.geradoEm)}</p>`;
  } else if (s.kind==='agenda'){
    inner = `<h2>${apexEsc(s.titulo)}</h2><ul class="apex-agenda">${s.itens.map(it=>`<li>• ${apexEsc(it)}</li>`).join('')}</ul>`;
  } else if (s.kind==='resumo'){
    const kpisHtml = (s.kpis||[]).map(k=>`<div class="apex-kpi"><div class="apex-kpi-lbl">${apexEsc(k.label)}</div><div class="apex-kpi-val">${apexEsc(k.value)}</div>${k.delta&&k.delta.texto?`<div class="apex-kpi-delta ${k.delta.bom===true?'up':k.delta.bom===false?'dn':''}">${apexEsc(k.delta.texto)}</div>`:''}</div>`).join('');
    let rankHtml = '';
    if (s.ranking && s.ranking.items && s.ranking.items.length){
      const max = Math.max.apply(null, s.ranking.items.map(x=>Math.abs(x.value))) || 1;
      rankHtml = `<div class="apex-rank"><div class="apex-rank-title">${apexEsc(s.ranking.titulo)}</div>${s.ranking.items.map(it=>{
        const pct = Math.round(Math.abs(it.value)/max*100);
        const valTxt = typeof it.value==='number' ? it.value.toLocaleString('pt-BR',{maximumFractionDigits:0}) : it.value;
        return `<div class="apex-rank-row"><span class="apex-rank-lbl">${apexEsc(it.label)}</span><div class="apex-rank-bar-bg"><div class="apex-rank-bar-fg" style="width:${pct}%"></div></div><span class="apex-rank-val">${apexEsc(valTxt)}</span></div>`;
      }).join('')}</div>`;
    }
    const notaHtml = (s.notas&&s.notas.length) ? `<p class="apex-nota">${s.notas.map(apexEsc).join(' ')}</p>` : '';
    inner = `<h2>${apexEsc(s.titulo)}</h2><div class="apex-kpigrid">${kpisHtml}</div>${rankHtml}${notaHtml}`;
  } else if (s.kind==='tabela'){
    inner = `<h2>${apexEsc(s.titulo)}</h2><div class="apex-tbl-wrap"><table class="apex-tbl"><thead><tr>${s.headers.map(h=>`<th>${apexEsc(h)}</th>`).join('')}</tr></thead><tbody>${s.rows.map(r=>`<tr>${r.map(c=>`<td>${apexEsc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else if (s.kind==='fechamento'){
    inner = `<h2>${apexEsc(s.titulo)}</h2>${(s.placeholders||[]).map(p=>`<p class="apex-placeholder">▸ ${apexEsc(p)}:<span class="apex-fill"></span></p>`).join('')}`;
  }
  return `<section class="apex-slide" data-kind="${s.kind}">
    <div class="apex-chrome-top"><span>Portal Comercial — Resultados Comerciais</span><span>${s.pageIdx} / ${s.pageTotal}</span></div>
    <div class="apex-body">${inner}</div>
    ${s.scopeLabel?`<div class="apex-chrome-bottom">${apexEsc(s.scopeLabel)}</div>`:''}
  </section>`;
}
function apexBuildHtml(deck){
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${apexEsc(deck.titulo)}</title>
<style>${APEX_HTML_CSS}</style>
</head><body>
<div id="apexDeck">${deck.slides.map(apexSlideHtml).join('')}</div>
<div class="apex-nav"><button id="apexPrev" title="Anterior (←)">‹</button><span id="apexCounter"></span><button id="apexNext" title="Próximo (→)">›</button></div>
<script>${APEX_HTML_JS}</script>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════
// UI — checklist, botões de download, preview inline
// ═══════════════════════════════════════════════════════════════════════
const APEX_STORAGE_KEY = 'apexSelecao';
function apexChecklistCarregar(){
  try { const v = JSON.parse(localStorage.getItem(APEX_STORAGE_KEY)); return Array.isArray(v)?v:[]; } catch(e){ return []; }
}
function apexChecklistSalvar(keys){
  try { localStorage.setItem(APEX_STORAGE_KEY, JSON.stringify(keys)); } catch(e){}
}
function apexToggleSelecao(key, checked){
  const atual = new Set(apexChecklistCarregar());
  if (checked) atual.add(key); else atual.delete(key);
  apexChecklistSalvar([...atual]);
}
function apexRenderChecklist(){
  const el = document.getElementById('apexChecklist');
  if (!el) return;
  const selecionados = new Set(apexChecklistCarregar());
  el.innerHTML = APEX_TABS.map(t=>`
    <label class="apex-check-opt">
      <input type="checkbox" value="${t.key}" ${selecionados.has(t.key)?'checked':''} onchange="apexToggleSelecao('${t.key}', this.checked)">
      <span><span class="apex-check-lbl">${t.label}</span><span class="apex-check-desc">${t.desc}</span></span>
    </label>`).join('');
  const tituloEl = document.getElementById('apexTitulo');
  if (tituloEl && !tituloEl.value){
    const { periodoLabel } = apexContextoAtivo();
    tituloEl.value = `Resultados Comerciais — ${periodoLabel}`;
  }
}

let apexUltimoDeck = null;
function apexGerar(){
  const statusEl = document.getElementById('apexStatus');
  const keys = apexChecklistCarregar().filter(k=>APEX_TABS.some(t=>t.key===k));
  if (!keys.length){
    if (statusEl) statusEl.innerHTML = '<div class="alert">⚠ Selecione ao menos uma aba na lista acima.</div>';
    return;
  }
  const tituloEl = document.getElementById('apexTitulo');
  let deck;
  try {
    deck = apexBuildDeck(keys, tituloEl?tituloEl.value:null);
  } catch(e){
    console.error('[apresentacao] falha ao montar o deck', e);
    if (statusEl) statusEl.innerHTML = `<div class="alert">⚠ Não consegui montar a apresentação: ${apexEsc(e.message)}</div>`;
    return;
  }
  apexUltimoDeck = deck;
  const iframe = document.getElementById('apexPreview');
  if (iframe) iframe.srcdoc = apexBuildHtml(deck);
  const btnPptx = document.getElementById('apexBtnPptx'), btnHtml = document.getElementById('apexBtnHtml');
  if (btnPptx) btnPptx.disabled = false;
  if (btnHtml) btnHtml.disabled = false;
  if (statusEl){
    const faltando = keys.filter(k=>!deck.abasIncluidas.includes(APEX_TABS.find(t=>t.key===k).label));
    statusEl.innerHTML = `<div class="alert">✔ Deck gerado — ${deck.slides.length} slides, ${deck.abasIncluidas.length} de ${keys.length} aba(s) selecionada(s) com dado disponível agora.${faltando.length?' Sem dado no momento: '+faltando.map(k=>APEX_TABS.find(t=>t.key===k).label).join(', ')+'.':''} Confira o preview abaixo antes de baixar.</div>`;
  }
}
async function apexBaixarPptxClick(){
  if (!apexUltimoDeck) return;
  const btn = document.getElementById('apexBtnPptx');
  if (btn){ btn.disabled = true; btn.textContent = 'Gerando PPTX…'; }
  try { await apexBuildPptx(apexUltimoDeck); }
  catch(e){ console.error('[apresentacao] falha ao gerar pptx', e); alert('Não consegui gerar o PPTX: '+e.message); }
  finally { if (btn){ btn.disabled = false; btn.textContent = '⬇ Baixar PPTX'; } }
}
function apexBaixarHtmlClick(){
  if (!apexUltimoDeck) return;
  const html = apexBuildHtml(apexUltimoDeck);
  const blob = new Blob([html], {type:'text/html;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (apexUltimoDeck.titulo||'apresentacao').replace(/[^\w\- ]+/g,'').trim() + '.html';
  a.click();
}

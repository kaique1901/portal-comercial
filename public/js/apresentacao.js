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
// up/dn = cor dos números e setas de comparativo (▲/▼ vs ano anterior):
// pedido explícito do usuário — AZUL quando positivo, vermelho quando
// negativo (diferente do verde/vermelho usado no resto do portal).
const APEX_COLORS = {
  bg:'FFFFFF', bg2:'EAEFEC', bg3:'DDE5E0',
  t1:'10241A', t2:'52685C', t3:'85978C',
  acc:'1F7A52', acc2:'2F9468', acc3:'0D5C3A',
  up:'1A56DB', dn:'B3261E', amb:'A3763A',
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
// pct = variação assinada (não só o texto) — usada pelo resumo executivo pra
// achar o maior destaque/pior ponto de atenção entre várias abas.
function apexDeltaTxt(cur, prev){
  if (cur==null || prev==null) return { texto:'sem histórico', bom:null, pct:null };
  if (prev===0) return { texto:'—', bom:null, pct:null };
  const d = (cur-prev)/prev*100;
  return { texto: `${d>=0?'▲':'▼'} ${Math.abs(d).toFixed(1)}%`, bom: d>=0, pct: d };
}
// Mesmo racional de deltaPP() do app.js: diferença em PONTOS PERCENTUAIS, não
// variação relativa — certo para comparar duas métricas que já são % (ex.:
// Margem % atual vs. Margem % do ano anterior). "pior" (lowerIsBetter) não se
// aplica aqui (margem maior é sempre melhor), por isso fixo bom = diff>=0.
function apexDeltaPP(curPct, prevPct){
  if (curPct==null || prevPct==null) return { texto:'sem base', bom:null, pp:null };
  const diff = curPct - prevPct;
  return { texto: `${diff>=0?'+':''}${diff.toFixed(1)} p.p.`, bom: diff>=0, pp: diff };
}
// Mesma fórmula de bonifCatSel (buildCategoriaTable, app.js) — soma a
// bonificação (codtpo 6/19) por categoria nos meses/escopo informados. Pura,
// sem efeito colateral, por isso é seguro reaproveitar aqui em vez de chamar
// buildCategoriaTable() (que tem seu próprio seletor de meses, que pode não
// bater com o da aba de onde este extractor está puxando dado).
function apexBonificacaoPorCategoria(d, level, names, meses){
  const b = d.bonificacao;
  if (!b || !b.por_mes_categoria) return null;
  const fontes = level && names && names.length ? names.map(n => (b.hier && b.hier[level] && b.hier[level][n]) || {}) : [b.por_mes_categoria];
  const out = {};
  fontes.forEach(fonte => meses.forEach(mes => {
    const mc = fonte[mes] || {};
    Object.keys(mc).forEach(cat => { out[cat] = (out[cat] || 0) + (mc[cat].r || 0); });
  }));
  return out;
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
// table.totalRow (opcional): linha "TOTAL GERAL" — aparece SÓ na última parte
// de linhas (não repete a cada página, já que é a soma de tudo), mas em TODA
// parte de coluna daquela página (cada bloco de colunas tem seu total). Pedido
// explícito do usuário: nunca mostrar categoria sem o total junto, no mesmo
// padrão de buildCategoriaTable()/tMcCat (TOTAL GERAL como última linha da
// própria tabela, não um KPI solto em outro slide).
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
    const isLastRowPart = rp === nRowParts-1;
    const rowSlice = rows.slice(rp*maxRows, (rp+1)*maxRows);
    for (let cp=0; cp<nColParts; cp++){
      const colStart = 1 + cp*maxCols, colEnd = Math.min(headers.length, colStart+maxCols);
      const hdr = [headers[0]].concat(headers.slice(colStart, colEnd));
      const rws = rowSlice.map(r => [r[0]].concat(r.slice(colStart, colEnd)));
      let totalRowIdx = null;
      if (isLastRowPart && table.totalRow){
        rws.push([table.totalRow[0]].concat(table.totalRow.slice(colStart, colEnd)));
        totalRowIdx = rws.length-1;
      }
      const parteIdx = rp*nColParts + cp + 1;
      const sufixo = totalPartes>1 ? ` — Parte ${parteIdx}/${totalPartes}` : '';
      partes.push({ titulo: table.titulo + sufixo, headers: hdr, rows: rws, totalRowIdx });
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
  const ranking = cats.length ? { titulo:'Participação por Categoria (Realizado)', tipo:'pizza', items: cats.slice().sort((a,b)=>b.real-a.real).map(c=>({label:c.nome, value:c.real})) } : null;

  const tables = cats.length ? [
    { titulo:'Faturamento por Categoria', headers:['Categoria','Meta','Realizado','Tendência','Ano Anterior','Δ Tend. vs Ano Ant.'],
      rows: cats.map(c=>[c.nome, fF(c.meta), fF(c.real), fF(c.trend), c.prevReal!=null?fF(c.prevReal):'sem base', apexDeltaTxt(c.trend,c.prevReal).texto]),
      totalRow: ['TOTAL GERAL', fF(built.totalMetaCat), fF(built.totalRealCat), fF(built.totalTrend), built.prevTotalRealCat!=null?fF(built.prevTotalRealCat):'sem base', apexDeltaTxt(built.totalTrend,built.prevTotalRealCat).texto] },
    { titulo:'Cash Margem por Categoria', headers:['Categoria','Meta Cash Margem','Cash Margem','Tendência Cash Margem','Ano Anterior','Δ vs Ano Ant.'],
      rows: cats.map(c=>[c.nome, c.metaCash>0?fF(c.metaCash):'—', fF(c.cash), fF(c.trendCash), c.prevCash!=null?fF(c.prevCash):'sem base', apexDeltaTxt(c.trendCash,c.prevCash).texto]),
      totalRow: ['TOTAL GERAL', built.totalMetaCash>0?fF(built.totalMetaCash):'—', fF(built.totalCash), fF(built.totalTrendCash), prevTotalCash!=null?fF(prevTotalCash):'sem base', apexDeltaTxt(built.totalTrendCash,prevTotalCash).texto] },
    { titulo:'Margem % e Positivação por Categoria', headers:['Categoria','Margem %','Positivação','Positivação Ano Ant.','Δ Positivação'],
      rows: cats.map(c=>[c.nome, c.margem!=null?fPct(c.margem):'—', c.nCliCat!=null?fN(c.nCliCat):'—', c.prevNCliCat!=null?fN(c.prevNCliCat):'—', apexDeltaTxt(c.nCliCat,c.prevNCliCat).texto]),
      totalRow: ['TOTAL GERAL', built.totalMargemGeral!=null?fPct(built.totalMargemGeral):'—', built.totalNCli!=null?fN(built.totalNCli):'—', built.prevTotalNCli!=null?fN(built.prevTotalNCli):'—', apexDeltaTxt(built.totalNCli,built.prevTotalNCli).texto] },
  ] : [];

  // Bonificação por categoria — mesma coluna que já existe na tabela original
  // desta aba no portal (celulasBonificacao em buildCategoriaTable).
  const bonifCat = cats.length ? apexBonificacaoPorCategoria(d, level, names, meses) : null;
  if (cats.length && bonifCat){
    const totalBonif = cats.reduce((s,c)=>s+(bonifCat[c.nome]||0),0);
    tables.push({ titulo:'Bonificação por Categoria', headers:['Categoria','Bonificação','% Bonif. x Venda'],
      rows: cats.map(c=>{ const v = bonifCat[c.nome]||0; return [c.nome, fF(v), c.real>0?fPct(v/c.real*100):'—']; }),
      totalRow: ['TOTAL GERAL', fF(totalBonif), built.totalRealCat>0?fPct(totalBonif/built.totalRealCat*100):'—'] });
  }

  return { tabKey:'obj', tabLabel:'Acompanhamento Objetivos', scopeLabel, kpis, tables, ranking, notas: built.realCatMonthNote?[built.realCatMonthNote]:[] };
}

function apexExtractMargemCash(){
  const res = renderMargemCash();
  if (!res) return null;
  const kpis = [
    { label:'Faturamento', value: fF(res.effR), delta: apexDeltaTxt(res.effR, res.prevEffR) },
    { label:'Cash Margem Total', value: fF(res.cash), delta: apexDeltaTxt(res.cash, res.prevCash) },
    { label:'Tendência Cash Margem', value: fF(res.trendCash) },
    { label:'Meta Margem %', value: res.metaMargemPct>0?fPct(res.metaMargemPct):'—' },
    { label:'Margem % (Realizado)', value: fPct(res.effM) },
    { label:'% Atingimento vs. Meta Margem', value: res.atingMargem!=null?fPct(res.atingMargem):'—' },
    { label:'Margem % Ano Anterior', value: res.prevM!=null?fPct(res.prevM):'—', delta: apexDeltaPP(res.effM, res.prevM) },
  ];
  const cats = res.catRowsFull || [];
  const ranking = cats.length ? { titulo:'Top Categorias por Cash Margem', items: cats.slice().sort((a,b)=>b.cash-a.cash).slice(0,5).map(c=>({label:c.nome, value:c.cash})) } : null;
  const tables = cats.length ? [{ titulo:'Margem & Cash Margem por Categoria', headers:['Categoria','Faturamento','Meta Cash Margem','Cash Margem','Tendência Cash Margem','Ano Anterior','Δ vs Ano Ant.','Meta Margem %','Margem %','Margem % Ano Ant.','Δ Margem (p.p.)'],
    rows: cats.map(c=>[c.nome, fF(c.r), c.metaCash>0?fF(c.metaCash):'—', fF(c.cash), fF(c.trendCash), c.prevCash!=null?fF(c.prevCash):'sem base', apexDeltaTxt(c.cash,c.prevCash).texto, c.metaMargemCat>0?fPct(c.metaMargemCat):'—', fPct(c.margem), c.prevMargem!=null?fPct(c.prevMargem):'sem base', apexDeltaPP(c.margem,c.prevMargem).texto]),
    totalRow: ['TOTAL GERAL', fF(res.effR), res.metaValRent>0?fF(res.metaValRent):'—', fF(res.cash), fF(res.trendCash), res.prevCash!=null?fF(res.prevCash):'sem base', apexDeltaTxt(res.cash,res.prevCash).texto, res.metaMargemPct>0?fPct(res.metaMargemPct):'—', fPct(res.effM), res.prevM!=null?fPct(res.prevM):'sem base', apexDeltaPP(res.effM,res.prevM).texto] }] : [];

  // Bonificação por categoria — mesma fórmula/fonte de Acompanhamento
  // Objetivos (apexBonificacaoPorCategoria), só que no escopo de mês desta
  // aba (ST.mes), não no seletor de período de Objetivos.
  const d = curPeriod();
  const level = hierLevelActive();
  const names = level ? hierSelectedNames(level) : [];
  const mesesBonif = ST.mes!=null ? [ST.mes] : Object.keys(d.por_mes||{}).map(Number);
  const bonifCat = apexBonificacaoPorCategoria(d, level, names, mesesBonif);
  if (cats.length && bonifCat){
    const totalBonif = cats.reduce((s,c)=>s+(bonifCat[c.nome]||0),0);
    tables.push({ titulo:'Bonificação por Categoria', headers:['Categoria','Bonificação','% Bonif. x Venda'],
      rows: cats.map(c=>{ const v = bonifCat[c.nome]||0; return [c.nome, fF(v), c.r>0?fPct(v/c.r*100):'—']; }),
      totalRow: ['TOTAL GERAL', fF(totalBonif), res.effR>0?fPct(totalBonif/res.effR*100):'—'] });
  }

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
  const top15 = clientes.slice(0,15);
  const totalReceita = clientes.reduce((s,c)=>s+c.receita,0);
  const totalPrevReceita = clientes.every(c=>c.prevReceita!=null) ? clientes.reduce((s,c)=>s+c.prevReceita,0) : null;
  const tables = clientes.length ? [{ titulo:'Top Clientes — Mix & Positivação', headers:['Cliente','Receita','Δ vs Ano Ant.','Categorias','Meses Ativos','Positivação'],
    rows: top15.map(c=>[c.nome, fF(c.receita), apexDeltaTxt(c.receita,c.prevReceita).texto, `${c.categorias} de ${res.nCatTotal}`, `${c.mesesAtivos} de ${c.nMeses}`, c.positivacaoPct+'%']),
    totalRow: [`TOTAL (${top15.length} de ${clientes.length} clientes)`, fF(totalReceita), apexDeltaTxt(totalReceita,totalPrevReceita).texto, '—', '—', mediaPositivacao!=null?mediaPositivacao.toFixed(0)+'% (média)':'—'] }] : [];
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
  return { tabKey:'kgfumo', tabLabel:'Metas KG Fumo, Papel e Estratégico', scopeLabel: res.scopeLabel || 'Empresa inteira', kpis, tables, ranking:null, notas:[] };
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
  const mediaDoGrupo = abaixoMeta.length ? abaixoMeta.reduce((s,v)=>s+v.stats.media,0)/abaixoMeta.length : 0;
  const tables = abaixoMetaTop.length ? [{ titulo:`Vendedores Abaixo da Meta (${abaixoMetaTop.length} de ${abaixoMeta.length}, piores médias)`, headers:['Vendedor','Supervisor','Média Mensal','Meses Ativos'],
    rows: abaixoMetaTop.map(v=>[v.nome, v.supervisor||'—', fF(v.stats.media), `${v.stats.mesesAtivos} de ${v.stats.nMesesFechados}`]),
    totalRow: [`MÉDIA DO GRUPO (${abaixoMeta.length} vendedores) · Média da Empresa: ${fF(mediaEmpresa)}`, '—', fF(mediaDoGrupo), '—'] }] : [];
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
  const ranking = catEntries.length ? { titulo:'Participação por Categoria (Valor em Estoque)', tipo:'pizza', items: catEntries.map(c=>({label:c.nome, value:c.valorTotal})) } : null;
  const tables = catEntries.length ? [{ titulo:'Estoque por Categoria', headers:['Categoria','Valor Estoque','Unidades','Cobertura (dias)'],
    rows: catEntries.map(c=>[c.nome, fF(c.valorTotal), fN(c.saldoTotal), c.dos!=null?fN(c.dos):'sem venda 90d']),
    totalRow: ['TOTAL GERAL', fF(geral.valorTotal), fN(geral.saldoTotal), geral.dos!=null?fN(geral.dos):'sem venda 90d'] }] : [];
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
  const totalValor = vendEntries.reduce((s,v)=>s+v.valorTotal,0), totalSaldo = vendEntries.reduce((s,v)=>s+v.saldoTotal,0), totalItens = vendEntries.reduce((s,v)=>s+v.nItens,0);
  const tables = topEntries.length ? [{ titulo:`Produtos Parados por Vendedor (${topEntries.length} de ${vendEntries.length}, maior valor parado)`, headers:['Vendedor','Valor Parado','Unidades Paradas','Itens','Pior Cobertura'],
    rows: topEntries.map(v=>[v.nome, fF(v.valorTotal), fN(v.saldoTotal), fN(v.nItens), v.hasNeverSold?'sem venda 90d':(v.worstDos!=null?fN(v.worstDos)+' dias':'—')]),
    totalRow: [`TOTAL GERAL (${vendEntries.length} vendedores)`, fF(totalValor), fN(totalSaldo), fN(totalItens), '—'] }] : [];
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
  const totalValor = vendEntries.reduce((s,v)=>s+v.valorTotal,0), totalSaldo = vendEntries.reduce((s,v)=>s+v.saldoTotal,0), totalItens = vendEntries.reduce((s,v)=>s+v.nItens,0);
  const tables = topEntries.length ? [{ titulo:`Produtos Letra P por Vendedor (${topEntries.length} de ${vendEntries.length}, maior valor)`, headers:['Vendedor','Valor em Estoque','Unidades','Itens'],
    rows: topEntries.map(v=>[v.nome, fF(v.valorTotal), fN(v.saldoTotal), fN(v.nItens)]),
    totalRow: [`TOTAL GERAL (${vendEntries.length} vendedores)`, fF(totalValor), fN(totalSaldo), fN(totalItens)] }] : [];
  const notas = vendEntries.length > topEntries.length ? [`Lista completa (${vendEntries.length} vendedores) disponível na aba "Produtos Letra P" do portal.`] : [];
  return { tabKey:'letrap', tabLabel:'Produtos Letra P', scopeLabel: apexContextoAtivo().escopoLabel, kpis, tables, ranking, notas };
}

function apexExtractVisaoGeral(){
  const res = renderVisao();
  if (!res) return null;
  const kpis = [
    { label:'Receita', value: fM(res.r), delta: apexDeltaTxt(res.r, res.prevR) },
    { label:'Margem %', value: fPct(res.effMargem), delta: apexDeltaTxt(res.effMargem, res.prevMargem) },
    { label:'Cash Margem', value: fM(res.cashMargem), delta: apexDeltaTxt(res.cashMargem, res.prevCashMargem) },
    { label:'Ticket Médio/Pedido', value: fF(res.ticket), delta: apexDeltaTxt(res.ticket, res.prevTicket) },
    { label:'Clientes Ativos', value: fN(res.nCli), delta: apexDeltaTxt(res.nCli, res.prevNCli) },
    { label:'Vendedores Ativos', value: fN(res.nVend), delta: apexDeltaTxt(res.nVend, res.prevNVend) },
  ];
  const ranking = res.categorias.length ? { titulo:'Mix por Categoria (Receita)', tipo:'pizza', items: res.categorias.map(c=>({label:c.nome, value:c.r})) } : null;
  const tables = res.gerentes.length ? [{ titulo:'Receita por Gerente', headers:['Gerente','Receita'],
    rows: res.gerentes.sort((a,b)=>b.r-a.r).map(g=>[g.nome, fF(g.r)]) }] : [];
  return { tabKey:'visao', tabLabel:'Visão Geral', scopeLabel: res.escopoLabel||'Empresa inteira', kpis, tables, ranking, notas:[] };
}

function apexExtractComparativos(){
  const res = renderComp();
  if (!res) return null;
  const kpis = res.linhas.map(l=>{
    const fmt = l.fmt==='pct'?fPct:l.fmt==='n'?fN:l.fmt==='f'?fF:fM;
    return { label:l.label, value:fmt(l.atual), delta: apexDeltaTxt(l.atual,l.anterior) };
  });
  const ranking = res.categorias.length ? { titulo:'Receita por Categoria — Atual vs. Ano Anterior', items: res.categorias.slice(0,8).map(c=>({label:c.nome, value:c.r})) } : null;
  const tables = res.categorias.length ? [{ titulo:'Comparativo por Categoria', headers:['Categoria','Receita Atual','Receita Ano Ant.','Δ'],
    rows: res.categorias.map(c=>[c.nome, fF(c.r), c.prevR!=null?fF(c.prevR):'sem base', apexDeltaTxt(c.r,c.prevR).texto]) }] : [];
  return { tabKey:'comp', tabLabel:'Comparativos', scopeLabel: `${res.periodoTxt} vs. ${res.prevLabel}`, kpis, tables, ranking, notas:[] };
}

function apexExtractRankings(){
  const res = renderRank();
  if (!res) return null;
  const kpis = [
    { label:'Maior Cliente (Receita)', value: res.clientes[0]?res.clientes[0].nome:'—' },
    { label:'Maior Vendedor (Receita)', value: res.vendedores[0]?res.vendedores[0].nome:'—' },
    { label:'Pior Margem (Ofensor)', value: res.ofensores[0]?`${res.ofensores[0].nome} (${fPct(res.ofensores[0].m)})`:'—' },
  ];
  const ranking = { titulo:'Top 5 Clientes por Receita', items: res.clientes.slice(0,5).map(c=>({label:c.nome, value:c.r})) };
  const tables = [
    { titulo:'Top 10 Clientes', headers:['Cliente','Receita','Margem %','Δ vs Ano Ant.'],
      rows: res.clientes.map(c=>[c.nome, fF(c.r), fPct(c.m), apexDeltaTxt(c.r,c.prevR).texto]) },
    { titulo:'Top 10 Vendedores', headers:['Vendedor','Receita','Margem %','Δ vs Ano Ant.'],
      rows: res.vendedores.map(v=>[v.nome, fF(v.r), fPct(v.m), apexDeltaTxt(v.r,v.prevR).texto]) },
    { titulo:'10 Piores Margens (Clientes)', headers:['Cliente','Receita','Margem %'],
      rows: res.ofensores.map(c=>[c.nome, fF(c.r), fPct(c.m)]) },
  ];
  return { tabKey:'rank', tabLabel:'Rankings', scopeLabel: res.scopeLabel||'Empresa inteira', kpis, tables, ranking, notas:[] };
}

function apexExtractTop50Cash(){
  const res = renderMargemCash();
  if (!res) return null;
  const ranking = { titulo:'Top 5 Vendedores por Cash Margem', items: (res.topVendedoresCash||[]).slice(0,5).map(v=>({label:v.nome, value:v.cash})) };
  const tables = [
    { titulo:'Top 10 Clientes por Cash Margem', headers:['Cliente','Receita','Cash Margem'],
      rows: (res.topClientesCash||[]).map(c=>[c.nome, fF(c.r), fF(c.r-c.c)]) },
    { titulo:'Top 10 Produtos por Cash Margem', headers:['Produto','Receita','Cash Margem'],
      rows: (res.topProdutosCash||[]).map(p=>[p.nome, fF(p.r), fF(p.r-p.c)]) },
    { titulo:'Vendedores por Cash Margem', headers:['Vendedor','Receita','Cash Margem'],
      rows: (res.topVendedoresCash||[]).map(v=>[v.nome, fF(v.r), fF(v.cash)]) },
  ];
  return { tabKey:'top50cash', tabLabel:'Top 50 Cash Margem', scopeLabel: apexContextoAtivo().escopoLabel, kpis:[], tables, ranking, notas:[] };
}

function apexExtractTop50Margem(){
  const res = renderMargemCash();
  if (!res) return null;
  const ranking = { titulo:'Top 5 Vendedores por Margem %', items: (res.topVendedoresMargem||[]).slice(0,5).map(v=>({label:v.nome, value:v.m})) };
  const tables = [
    { titulo:'Top 10 Clientes por Margem %', headers:['Cliente','Receita','Margem %'],
      rows: (res.topClientesMargem||[]).map(c=>[c.nome, fF(c.r), fPct(c.m)]) },
    { titulo:'Top 10 Produtos por Margem %', headers:['Produto','Receita','Margem %'],
      rows: (res.topProdutosMargem||[]).map(p=>[p.nome, fF(p.r), fPct(p.m)]) },
    { titulo:'Vendedores por Margem %', headers:['Vendedor','Receita','Margem %'],
      rows: (res.topVendedoresMargem||[]).map(v=>[v.nome, fF(v.r), fPct(v.m)]) },
  ];
  return { tabKey:'top50margem', tabLabel:'Top 50 Margem %', scopeLabel: apexContextoAtivo().escopoLabel, kpis:[], tables, ranking, notas:[] };
}

function apexExtractCascata(){
  const d = curPeriod(), prev = prevPeriod();
  if (!d || !d.cascata) return null;
  const cats = Object.entries(d.cascata).map(([nome,v])=>({
    nome, r:v.r, c:v.c, m:v.m,
    prevR: (prev && prev.cascata && prev.cascata[nome]) ? prev.cascata[nome].r : null,
  })).sort((a,b)=>b.r-a.r);
  if (!cats.length) return null;
  const totalR = cats.reduce((s,c)=>s+c.r,0), totalC = cats.reduce((s,c)=>s+c.c,0);
  const totalPrevR = cats.every(c=>c.prevR!=null) ? cats.reduce((s,c)=>s+c.prevR,0) : null;
  const kpis = [
    { label:'Faturamento Total', value: fF(totalR), delta: apexDeltaTxt(totalR, totalPrevR) },
    { label:'Margem % Geral', value: totalR>0?fPct(100*(1-totalC/totalR)):'—' },
  ];
  const ranking = { titulo:'Participação por Categoria (Faturamento)', tipo:'pizza', items: cats.map(c=>({label:c.nome, value:c.r})) };
  const tables = [{ titulo:'Análise em Cascata — por Categoria', headers:['Categoria','Faturamento','Margem %','Δ vs Ano Ant.'],
    rows: cats.map(c=>[c.nome, fF(c.r), fPct(c.m), apexDeltaTxt(c.r,c.prevR).texto]),
    totalRow: ['TOTAL GERAL', fF(totalR), totalR>0?fPct(100*(1-totalC/totalR)):'—', apexDeltaTxt(totalR,totalPrevR).texto] }];
  return { tabKey:'cascata', tabLabel:'Análise em Cascata', scopeLabel:'Empresa inteira', kpis, tables, ranking,
    notas:['Cubo fechado por semestre, nível empresa — não recortável por Gerente/Supervisor/Vendedor.'] };
}

function apexExtractDias(){
  const res = renderDias();
  if (!res) return null;
  const melhor = res.byDow.slice().sort((a,b)=>b.receita-a.receita)[0];
  const pior = res.byDow.slice().sort((a,b)=>a.receita-b.receita)[0];
  const kpis = [
    { label:'Melhor dia (Receita)', value: `${melhor.nome} — ${fF(melhor.receita)}`, delta: apexDeltaTxt(melhor.receita, melhor.prevReceita) },
    { label:'Pior dia (Receita)', value: `${pior.nome} — ${fF(pior.receita)}`, delta: apexDeltaTxt(pior.receita, pior.prevReceita) },
  ];
  const ranking = { titulo:'Faturamento por Dia da Semana', items: res.byDow.map(x=>({label:x.nome, value:x.receita})) };
  const tables = [{ titulo:'Receita por Dia da Semana', headers:['Dia','Receita','Ano Anterior','Δ vs Ano Ant.'],
    rows: res.byDow.map(x=>[x.nome, fF(x.receita), x.prevReceita!=null?fF(x.prevReceita):'sem base', apexDeltaTxt(x.receita,x.prevReceita).texto]) }];
  return { tabKey:'dias', tabLabel:'Sazonalidade (Dia da Semana)', scopeLabel: res.label, kpis, tables, ranking, notas:[] };
}

function apexExtractDowCascata(){
  const dc = REAL_DATA._dowCascata;
  if (!dc || !dc.porDow) return null;
  const porDia = DOW_ORDER.map(dow=>{
    const catMap = dc.porDow[dow]||{};
    let r=0,c=0;
    Object.values(catMap).forEach(items=>{ items.forEach(p=>{ r+=p.r; c+=p.c; }); });
    return { dow, nome: DOW_NAMES[dow], r, c };
  });
  const melhor = porDia.slice().sort((a,b)=>b.r-a.r)[0];
  const kpis = [
    { label:'Melhor dia (90d)', value: `${melhor.nome} — ${fF(melhor.r)}` },
    { label:'Janela', value: `${fmtBR(dc.janela.inicio)} a ${fmtBR(dc.janela.fim)}` },
  ];
  const ranking = { titulo:'Faturamento por Dia da Semana (90 dias)', items: porDia.map(x=>({label:x.nome, value:x.r})) };
  const tables = [{ titulo:'Vendas por Dia da Semana (últimos 90 dias)', headers:['Dia','Faturamento','Cash Margem','Margem %'],
    rows: porDia.map(x=>[x.nome, fF(x.r), fF(x.r-x.c), x.r>0?fPct(100*(1-x.c/x.r)):'—']) }];
  return { tabKey:'dowcasc', tabLabel:'Vendas por Dia da Semana', scopeLabel:'Últimos 90 dias (janela fixa — não é o período selecionado no filtro)', kpis, tables, ranking,
    notas:['Janela sempre dos últimos 90 dias corridos até hoje — não muda com o filtro de Período.'] };
}

function apexExtractAbcd(){
  const res = renderAbcd();
  if (!res) return null;
  const a = res.grupos.find(g=>g.letra==='A');
  const kpis = [
    { label:'Grupo A — Clientes-âncora', value: fN(a.count)+' clientes' },
    { label:'Grupo A — Receita', value: fF(a.receita)+` (${a.pct.toFixed(1)}%)` },
    { label:'Grupo A — Cash Margem', value: fF(a.cashMargin) },
  ];
  const ranking = { titulo:'Participação na Receita por Grupo (A–I)', tipo:'pizza', items: res.grupos.map(g=>({label:g.letra+' — '+g.titulo, value:g.receita})) };
  const tables = [
    { titulo:'Classificação de Clientes (A–I)', headers:['Grupo','Clientes','Receita','% Receita','Cash Margem'],
      rows: res.grupos.map(g=>[`${g.letra} — ${g.titulo}`, fN(g.count), fF(g.receita), g.pct.toFixed(1)+'%', fF(g.cashMargin)]) },
    { titulo:'Top 5 Clientes — Grupo A (Âncoras)', headers:['Cliente','Receita','Cash Margem','Margem %'],
      rows: res.topGrupoA.map(c=>[c.nome, fF(c.r), fF(c.r-c.c), fPct(c.m)]) },
  ];
  return { tabKey:'abcd', tabLabel:'Clientes de A a I', scopeLabel: `Últimos 90 dias (${res.janela.inicio} a ${res.janela.fim})`, kpis, tables, ranking, notas:[] };
}

function apexExtractPlanos(){
  const res = renderPlanoMesVigente();
  if (!res) return null;
  const g = res.geral;
  const kpis = [
    { label:'Meta do Mês', value: fF(g.meta) },
    { label:'Realizado', value: fF(g.real), delta: g.pctReal!=null?{ texto:fPct(g.pctReal)+' da meta', bom:g.pctReal>=100 }:null },
    { label:'Tendência de Fechamento', value: fF(g.trend), delta: g.pctTrend!=null?{ texto:fPct(g.pctTrend)+' da meta', bom:g.pctTrend>=100 }:null },
    { label:'Falta para 100%', value: fF(g.gap) },
  ];
  const ranking = res.categoriasUrgentes.length ? { titulo:'Categorias Mais Urgentes (% Tendência)', items: res.categoriasUrgentes.map(c=>({label:c.nome, value:c.pctTrend||0})) } : null;
  const tables = res.categoriasUrgentes.length ? [{ titulo:'Categorias — Meta x Tendência (Mês Vigente)', headers:['Categoria','Meta','Realizado','% Ating.','Tendência','% Tendência','Falta p/ 100%'],
    rows: res.categoriasUrgentes.map(c=>[c.nome, fF(c.meta), fF(c.real), c.pctReal!=null?fPct(c.pctReal):'—', fF(c.trend), c.pctTrend!=null?fPct(c.pctTrend):'—', fF(c.gap)]) }] : [];
  return { tabKey:'planos', tabLabel:'Planos de Ação', scopeLabel: `${res.mesLabel}${res.scopeLabel?' · '+res.scopeLabel:''} — dia ${res.diaAtual} de ${res.diasNoMes}`, kpis, tables, ranking, notas:[] };
}

function apexExtractPagamento(){
  const res = renderPagamento();
  if (!res) return null;
  const kpis = res.kpis.slice(0,3).map(k=>({ label:k.label, value:fM(k.atual), delta: apexDeltaTxt(k.atual,k.anterior) }));
  const metodos = res.kpis.slice(3);
  const ranking = metodos.length ? { titulo:'Participação por Forma de Pagamento', tipo:'pizza', items: metodos.map(k=>({label:k.label, value:k.atual})) } : null;
  const tables = [{ titulo:'Totais por Tipo de Documento e Forma de Pagamento', headers:['Indicador','Valor','Ano Anterior','Δ vs Ano Ant.'],
    rows: res.kpis.map(k=>[k.label, fF(k.atual), k.anterior!=null?fF(k.anterior):'sem base', apexDeltaTxt(k.atual,k.anterior).texto]) }];
  if (res.topGerentes.length) tables.push({ titulo:'Top 5 Gerentes por Total', headers:['Gerente','Total'], rows: res.topGerentes.map(g=>[g.nome, fF(g.total)]) });
  return { tabKey:'pagamento', tabLabel:'Vendas por Tipo de Pagamento', scopeLabel: res.scopeLabel||'Empresa inteira', kpis, tables, ranking, notas:[] };
}

function apexExtractInadimplencia(){
  const res = renderInadimplencia();
  if (!res) return null;
  const kpis = [
    { label:'Saldo em Aberto', value: fF(res.saldo) },
    { label:'Clientes Inadimplentes', value: fN(res.clientes) },
    { label:'Títulos Vencidos', value: fN(res.titulos) },
    { label:'Vencido há +1 Ano', value: fF(res.f365Mais)+` (${res.vencidoAntigoPct.toFixed(1)}%)` },
    { label:'Maior Atraso', value: fN(res.atrasoMax)+' dias' },
  ];
  const ranking = res.topDevedores.length ? { titulo:'Top 5 Devedores por Saldo', items: res.topDevedores.map(c=>({label:c.nome, value:c.saldo})) } : null;
  const tables = res.topDevedores.length ? [{ titulo:'Top Devedores', headers:['Cliente','Saldo em Aberto','Maior Atraso (dias)'],
    rows: res.topDevedores.map(c=>[c.nome, fF(c.saldo), fN(c.atrasoMax)]) }] : [];
  return { tabKey:'inad', tabLabel:'Inadimplência por Carteira', scopeLabel:`Posição em ${res.geradoEm}`, kpis, tables, ranking,
    notas:['Fotografia atual — não muda com o filtro de Período/Mês.'] };
}

function apexExtractClientesSemCompra(){
  const res = renderClientesSemCompra();
  if (!res) return null;
  const kpis = [
    { label:'Clientes no Recorte', value: fN(res.clientes) },
    { label:'Média de Dias sem Compra', value: fN(res.mediaDias)+' dias' },
    { label:'Maior Tempo sem Compra', value: res.maiorTempo!=null?fN(res.maiorTempo)+' dias':'—' },
  ];
  const top8 = res.gerentes.slice(0,8);
  const ranking = top8.length ? { titulo:'Clientes Parados por Gerente', items: top8.map(g=>({label:g.nome, value:g.clientes})) } : null;
  const tables = top8.length ? [{ titulo:'Clientes sem Compra por Gerente', headers:['Gerente','Clientes','Média Dias sem Compra'],
    rows: top8.map(g=>[g.nome, fN(g.clientes), fN(g.mediaDias)+' dias']) }] : [];
  return { tabKey:'semcompra', tabLabel:'Clientes sem Compra (60+ dias)', scopeLabel:`Posição em ${res.geradoEm}`, kpis, tables, ranking,
    notas:['Fotografia atual (clientes ativos, não inadimplentes) — não muda com o filtro de Período/Mês. Sem meta/ano anterior nesta aba — é um indicador de oportunidade de reativação, não de tendência.'] };
}

function apexStripTags(html){ return String(html||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(); }

function apexExtractRiscoOport(){
  const res = renderRiscoOport();
  if (!res) return null;
  const itens = res.riscos.concat(res.oports).map(x=>({ titulo:x.titulo, severidade:x.badge, detalhe:apexStripTags(x.corpo) }));
  if (!itens.length) return null;
  return { tabKey:'risco', tabLabel:'Riscos & Oportunidades', scopeLabel: res.scopeLabel||'Empresa inteira', kpis:[], tables:[], ranking:null, insights: itens, notas:[] };
}

function apexExtractRiscoOportCat(){
  const res = renderRiscoOportCat();
  if (!res) return null;
  const itens = res.riscos.concat(res.oports).map(x=>({ titulo:x.titulo, severidade:x.badge, detalhe:apexStripTags(x.corpo) }));
  if (!itens.length) return null;
  return { tabKey:'riscocat', tabLabel:'Riscos & Oport. por Categoria', scopeLabel: res.scopeLabel||'Empresa inteira', kpis:[], tables:[], ranking:null, insights: itens, notas:[] };
}

// ═══════════════════════════════════════════════════════════════════════
// RESUMO EXECUTIVO ("Próximos Passos") — sintetiza, a partir dos specs já
// extraídos (nunca recalcula nada), o destaque mais positivo, o ponto de
// atenção mais crítico e uma ação recomendada. Usa Riscos & Oportunidades
// quando a aba foi incluída (é a fonte mais "curada" para isso); cai para o
// maior/menor delta entre os KPIs das abas incluídas quando não foi.
// ═══════════════════════════════════════════════════════════════════════
function apexResumoExecutivo(specs){
  // Um KPI cujo RÓTULO já é negativo (ex.: "Pior dia", "Vendedores Abaixo da
  // Meta") não deve virar "Destaque" só porque o delta deu positivo — e
  // vice-versa (um rótulo "Melhor X"/"Maior X" não deve virar "Ponto de
  // Atenção" mesmo com delta negativo). Fica de fora dos dois lados.
  const rotuloAmbiguo = /pior|menor|abaixo|queda|parad|melhor|maior|\btop\b/i;
  let melhor = null, pior = null;
  specs.forEach(spec=>{
    (spec.kpis||[]).forEach(k=>{
      if (!k.delta || k.delta.pct==null || rotuloAmbiguo.test(k.label)) return;
      if (k.delta.bom===true && (!melhor || k.delta.pct>melhor.k.delta.pct)) melhor = { spec, k };
      if (k.delta.bom===false && (!pior || k.delta.pct<pior.k.delta.pct)) pior = { spec, k };
    });
  });
  // Receita Geral (Visão Geral/Comparativos) é sempre o destaque preferencial
  // quando positiva — mais relevante pra diretoria do que uma métrica
  // secundária com % maior só por ser uma base pequena (ex.: um único dia da
  // semana). Só cai pro maior delta genérico quando a Receita não está
  // disponível ou não é positiva.
  const headlineSpec = specs.find(s=>s.tabKey==='visao') || specs.find(s=>s.tabKey==='comp');
  const headlineKpi = headlineSpec && (headlineSpec.kpis||[]).find(k=>/^receita/i.test(k.label));
  if (headlineKpi && headlineKpi.delta && headlineKpi.delta.bom===true) melhor = { spec: headlineSpec, k: headlineKpi };

  const destaque = melhor
    ? `${melhor.spec.tabLabel} — ${melhor.k.label}: ${melhor.k.value} (${melhor.k.delta.texto} vs. ano anterior).`
    : 'Nenhuma aba selecionada trouxe comparativo com o ano anterior — inclua mais abas ou verifique se há semestre equivalente no ano passado.';

  const riscoSpec = specs.find(s=>s.tabKey==='risco') || specs.find(s=>s.tabKey==='riscocat');
  let atencao = null;
  // Receita geral em queda é sempre o ponto de atenção #1 pra diretoria —
  // antes de qualquer risco estrutural "curado" (concentração, estoque etc.).
  if (headlineKpi && headlineKpi.delta && headlineKpi.delta.bom===false){
    atencao = `${headlineSpec.tabLabel} — ${headlineKpi.label}: ${headlineKpi.value} (${headlineKpi.delta.texto} vs. ano anterior).`;
  }
  if (!atencao && riscoSpec && riscoSpec.insights){
    const item = riscoSpec.insights.find(i=>i.severidade==='CRÍTICO') || riscoSpec.insights.find(i=>i.severidade==='ALTO');
    if (item) atencao = `${item.titulo} — ${item.detalhe}`;
  }
  if (!atencao){
    atencao = pior
      ? `${pior.spec.tabLabel} — ${pior.k.label}: ${pior.k.value} (${pior.k.delta.texto} vs. ano anterior).`
      : 'Nenhum ponto crítico identificado nos indicadores das abas selecionadas — inclua "Riscos & Oportunidades" para uma leitura mais qualitativa.';
  }

  let acao = null;
  if (riscoSpec && riscoSpec.insights){
    const item = riscoSpec.insights.find(i=>i.severidade==='OPORTUNIDADE');
    if (item) acao = `${item.titulo} — ${item.detalhe}`;
  }
  if (!acao){
    const planosSpec = specs.find(s=>s.tabKey==='planos');
    const urgente = planosSpec && planosSpec.tables && planosSpec.tables[0] && planosSpec.tables[0].rows[0];
    if (urgente) acao = `Priorizar a categoria ${urgente[0]} no mês vigente — faltam ${urgente[6]} para a meta (tendência de fechamento: ${urgente[5]} da meta).`;
  }
  if (!acao){
    const vendSpec = specs.find(s=>s.tabKey==='vendmeta');
    if (vendSpec && vendSpec.ranking && vendSpec.ranking.items.length) acao = `Priorizar plano de ação para ${vendSpec.ranking.items[0].label}, o vendedor com menor média mensal no escopo.`;
  }
  if (!acao) acao = 'Revisar as categorias/vendedores abaixo da meta nas abas incluídas e definir plano de recuperação para o próximo período.';

  return { destaque, atencao, acao };
}

// Registro central — adicionar uma aba nova no futuro é só empurrar 1 item
// aqui (a UI de checklist e o motor de slides são genéricos).
const APEX_TABS = [
  { key:'visao', label:'Visão Geral', desc:'Receita, margem, cash margem e mix por categoria do ano vigente.', extractor: apexExtractVisaoGeral },
  { key:'comp', label:'Comparativos', desc:'Receita, margem, cash margem e qtde — ano atual vs. ano anterior.', extractor: apexExtractComparativos },
  { key:'obj', label:'Acompanhamento Objetivos', desc:'Meta x Realizado x Tendência x Margem x Positivação por categoria.', extractor: apexExtractObjetivos },
  { key:'mc', label:'Margem & Cash Margem', desc:'Cash Margem total, tendência de fechamento e ranking por categoria.', extractor: apexExtractMargemCash },
  { key:'top50cash', label:'Top 50 Cash Margem', desc:'Top clientes, produtos e vendedores por Cash Margem (R$).', extractor: apexExtractTop50Cash },
  { key:'top50margem', label:'Top 50 Margem %', desc:'Top clientes, produtos e vendedores por Margem % (razão).', extractor: apexExtractTop50Margem },
  { key:'kgfumo', label:'Metas KG Fumo, Papel e Estratégico', desc:'Meta x tendência x ano anterior das 3 métricas especiais.', extractor: apexExtractKgFumo },
  { key:'cascata', label:'Análise em Cascata', desc:'Faturamento e margem por categoria (cubo fechado por semestre).', extractor: apexExtractCascata },
  { key:'dias', label:'Sazonalidade (Dia da Semana)', desc:'Receita por dia da semana no período selecionado, vs. ano anterior.', extractor: apexExtractDias },
  { key:'dowcasc', label:'Vendas por Dia da Semana', desc:'Faturamento por dia da semana — janela fixa dos últimos 90 dias.', extractor: apexExtractDowCascata },
  { key:'rank', label:'Rankings', desc:'Top clientes, produtos, vendedores e piores margens (ofensores).', extractor: apexExtractRankings },
  { key:'mix', label:'Mix & Positivação', desc:'Top clientes por receita, categorias distintas e positivação.', extractor: apexExtractMix },
  { key:'abcd', label:'Clientes de A a I', desc:'Classificação de clientes por Faturamento x Margem (últimos 90 dias).', extractor: apexExtractAbcd },
  { key:'planos', label:'Planos de Ação', desc:'Meta x Realizado x Tendência do mês vigente, geral e por categoria.', extractor: apexExtractPlanos },
  { key:'vendmeta', label:'Vendedores Abaixo da Meta', desc:'Vendedores abaixo do piso de R$150 mil/R$200 mil por mês.', extractor: apexExtractVendedoresMeta },
  { key:'estoque', label:'Estoque x Venda (90 dias)', desc:'Valor de estoque, cobertura média e ranking por categoria.', extractor: apexExtractEstoque },
  { key:'paradosvend', label:'Produtos Parados por Vendedor', desc:'Valor parado (>90 dias de cobertura) por vendedor.', extractor: apexExtractProdutosParadosVend },
  { key:'letrap', label:'Produtos Letra P', desc:'Estoque de produtos com descrição "(P)" por vendedor.', extractor: apexExtractProdutosLetraP },
  { key:'pagamento', label:'Vendas por Tipo de Pagamento', desc:'Total por Nota Fiscal/Cupom e por forma de pagamento.', extractor: apexExtractPagamento },
  { key:'inad', label:'Inadimplência por Carteira', desc:'Saldo em aberto, clientes inadimplentes e top devedores.', extractor: apexExtractInadimplencia },
  { key:'semcompra', label:'Clientes sem Compra (60+ dias)', desc:'Clientes ativos sem comprar há 60+ dias, por gerente.', extractor: apexExtractClientesSemCompra },
  { key:'risco', label:'Riscos & Oportunidades', desc:'Riscos e oportunidades priorizados, com severidade e valor estimado.', extractor: apexExtractRiscoOport },
  { key:'riscocat', label:'Riscos & Oport. por Categoria', desc:'Riscos e oportunidades por categoria de produto.', extractor: apexExtractRiscoOportCat },
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
    const temResumo = (spec.kpis && spec.kpis.length) || (spec.ranking && spec.ranking.items && spec.ranking.items.length);
    if (temResumo){
      slides.push({ kind:'resumo', tabLabel:spec.tabLabel, titulo:spec.tabLabel, scopeLabel:spec.scopeLabel, kpis:spec.kpis, ranking:spec.ranking, notas:spec.notas });
    }
    (spec.tables||[]).forEach(table=>{
      apexSplitTable(table).forEach(parte=>{
        slides.push({ kind:'tabela', tabLabel:spec.tabLabel, titulo:parte.titulo, headers:parte.headers, rows:parte.rows, totalRowIdx:parte.totalRowIdx, scopeLabel:spec.scopeLabel });
      });
    });
    // Slides narrativos (Riscos & Oportunidades) — cards de texto curado, não
    // tabela: 4 por slide pra não lotar.
    if (spec.insights && spec.insights.length){
      const porSlide = 4;
      const totalGrupos = Math.ceil(spec.insights.length/porSlide);
      for (let i=0; i<spec.insights.length; i+=porSlide){
        const grupo = spec.insights.slice(i, i+porSlide);
        const sufixo = totalGrupos>1 ? ` — Parte ${Math.floor(i/porSlide)+1}/${totalGrupos}` : '';
        slides.push({ kind:'insights', tabLabel:spec.tabLabel, titulo:spec.tabLabel+sufixo, itens:grupo, scopeLabel:spec.scopeLabel });
      }
    }
  });
  const resumoExec = apexResumoExecutivo(specs);
  slides.push({ kind:'fechamento', titulo:'Próximos Passos', itens:[
    { label:'Destaque do período', texto: resumoExec.destaque },
    { label:'Ponto de atenção', texto: resumoExec.atencao },
    { label:'Ação recomendada', texto: resumoExec.acao },
  ] });

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
        const chartH = Math.max(1.8, 6.85 - y - (s.notas&&s.notas.length?0.4:0));
        slide.addText(s.ranking.titulo, { x:0.6, y, w:12.1, h:0.3, fontSize:12, bold:true, color:APEX_COLORS.t2 });
        const chartColors = [APEX_COLORS.acc, APEX_COLORS.acc2, APEX_COLORS.amb, APEX_COLORS.dn, APEX_COLORS.acc3, APEX_COLORS.t3, APEX_COLORS.up, APEX_COLORS.bg3];
        if (s.ranking.tipo === 'pizza'){
          const chartData = [{ name: s.ranking.titulo, labels: s.ranking.items.map(it=>String(it.label)), values: s.ranking.items.map(it=>Math.round(Math.abs(it.value))) }];
          slide.addChart(pres.ChartType.pie, chartData, { x:3.1, y:y+0.32, w:6.5, h:chartH-0.32, showValue:true, showPercent:true, dataLabelColor:'FFFFFF', chartColors, showLegend:true, legendPos:'r', legendColor:APEX_COLORS.t2 });
        } else {
          const chartData = [{ name: s.ranking.titulo, labels: s.ranking.items.map(it=>String(it.label)), values: s.ranking.items.map(it=>Math.round(it.value)) }];
          slide.addChart(pres.ChartType.bar, chartData, { x:0.6, y:y+0.32, w:11.9, h:chartH-0.32, barDir:'bar', showValue:true, chartColors:[APEX_COLORS.acc], showLegend:false });
        }
      }
      if (s.notas && s.notas.length){
        slide.addText(s.notas.join(' '), { x:0.6, y:6.7, w:12.1, h:0.35, fontSize:9, italic:true, color:APEX_COLORS.t3 });
      }

    } else if (s.kind === 'tabela'){
      slide.addText(s.titulo, { x:0.6, y:0.5, w:12.1, h:0.5, fontSize:19, bold:true, color:APEX_COLORS.t1 });
      const nCols = s.headers.length;
      const fontSize = nCols<=4?12:nCols<=6?11:10;
      const headerRow = s.headers.map(h=>({ text:h, options:{ bold:true, fill:{color:APEX_COLORS.acc}, color:'FFFFFF', fontSize } }));
      // Célula de comparativo (texto começa com ▲/▼, ex.: "▲ 22.6%") ganha a
      // mesma cor azul/vermelho dos KPIs — pedido explícito do usuário em
      // QUALQUER tabela da apresentação, não só nos cards de resumo.
      const bodyRows = s.rows.map((r,i)=>r.map(cell=>{
        const text = String(cell);
        const opts = { fontSize, bold: i===s.totalRowIdx, fill: i===s.totalRowIdx?{color:APEX_COLORS.bg2}:undefined };
        if (text.indexOf('▲')===0) opts.color = APEX_COLORS.up;
        else if (text.indexOf('▼')===0) opts.color = APEX_COLORS.dn;
        return { text, options: opts };
      }));
      slide.addTable([headerRow].concat(bodyRows), { x:0.4, y:1.15, w:12.5, fontSize, border:{type:'solid', color:APEX_COLORS.bg3, pt:0.5}, autoPage:false });

    } else if (s.kind === 'insights'){
      slide.addText(s.titulo, { x:0.6, y:0.5, w:12.1, h:0.5, fontSize:20, bold:true, color:APEX_COLORS.acc3 });
      (s.itens||[]).forEach((it,i)=>{
        const y2 = 1.25 + i*1.35;
        slide.addShape(pres.ShapeType.roundRect, { x:0.6, y:y2, w:12.1, h:1.2, fill:{color:APEX_COLORS.bg2}, line:{type:'none'}, rectRadius:0.05 });
        const corSev = it.severidade==='CRÍTICO'?APEX_COLORS.dn:it.severidade==='ALTO'?APEX_COLORS.amb:APEX_COLORS.acc2;
        slide.addText(it.severidade||'', { x:0.8, y:y2+0.1, w:2, h:0.3, fontSize:10, bold:true, color:corSev });
        slide.addText(it.titulo, { x:0.8, y:y2+0.38, w:11.7, h:0.4, fontSize:14, bold:true, color:APEX_COLORS.t1 });
        slide.addText(it.detalhe||'', { x:0.8, y:y2+0.78, w:11.7, h:0.35, fontSize:10.5, color:APEX_COLORS.t2 });
      });

    } else if (s.kind === 'fechamento'){
      slide.addText(s.titulo, { x:0.6, y:0.55, w:12.1, h:0.6, fontSize:24, bold:true, color:APEX_COLORS.acc3 });
      (s.itens||[]).forEach((it,i)=>{
        const y2 = 1.45 + i*1.85;
        slide.addText(`▸ ${it.label}`, { x:0.6, y:y2, w:11.9, h:0.4, fontSize:15, bold:true, color:APEX_COLORS.t2 });
        slide.addText(it.texto, { x:0.9, y:y2+0.42, w:11.6, h:1.3, fontSize:12.5, color:APEX_COLORS.t1, valign:'top' });
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
:root{--bg:#ffffff;--bg2:#eaefec;--bg3:#dde5e0;--t1:#10241a;--t2:#52685c;--t3:#85978c;--acc:#1f7a52;--acc3:#0d5c3a;--up:#1a56db;--dn:#b3261e;--bdr:rgba(16,36,26,.10)}
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
.apex-pie-wrap{display:flex;align-items:center;gap:28px;margin-top:6px}
.apex-pie{width:160px;height:160px;border-radius:50%;flex-shrink:0;box-shadow:inset 0 0 0 1px var(--bdr)}
.apex-pie-legend{display:flex;flex-direction:column;gap:6px}
.apex-pie-leg-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--t2)}
.apex-pie-sw{width:11px;height:11px;border-radius:3px;flex-shrink:0}
.apex-pie-leg-lbl{min-width:160px}
.apex-pie-leg-val{font-weight:700;color:var(--t1)}
.apex-nota{font-size:10.5px;color:var(--t3);margin-top:14px;font-style:italic}
.apex-tbl-wrap{overflow:auto;flex:1;min-height:0}
.apex-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.apex-tbl th{background:var(--acc);color:#fff;padding:6px 9px;text-align:left;position:sticky;top:0;white-space:nowrap}
.apex-tbl td{padding:5px 9px;border-bottom:1px solid var(--bdr);white-space:nowrap}
.apex-tbl tr:nth-child(even) td{background:rgba(31,122,82,.04)}
.apex-tbl-total td{background:var(--bg2) !important;font-weight:700;border-top:2px solid var(--acc)}
.apex-cell-up{color:var(--up);font-weight:600}
.apex-cell-dn{color:var(--dn);font-weight:600}
.apex-insight{background:var(--bg2);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.apex-insight-sev{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;padding:2px 8px;border-radius:8px;margin-bottom:6px;color:var(--acc2);background:rgba(47,148,104,.14)}
.apex-insight-sev.crítico{color:var(--dn);background:rgba(179,38,30,.12)}
.apex-insight-sev.alto{color:#a3763a;background:rgba(163,118,58,.14)}
.apex-insight-tit{font-size:15px;font-weight:700;color:var(--t1);margin-bottom:4px}
.apex-insight-det{font-size:12px;color:var(--t2);line-height:1.5}
.apex-proximo{margin-bottom:22px}
.apex-proximo-lbl{font-size:14px;font-weight:700;color:var(--acc3);margin-bottom:6px}
.apex-proximo-txt{font-size:14px;color:var(--t1);line-height:1.6}
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
// Célula de tabela que É um comparativo (texto começa com ▲/▼, ex.: "▲ 22.6%"
// ou "▲ +6.2 p.p.") ganha a mesma cor azul/vermelho dos KPIs — em QUALQUER
// tabela da apresentação, não só nos cards de resumo.
function apexColorirCelula(valor){
  const s = apexEsc(valor);
  if (s.indexOf('▲')===0) return `<span class="apex-cell-up">${s}</span>`;
  if (s.indexOf('▼')===0) return `<span class="apex-cell-dn">${s}</span>`;
  return s;
}
const APEX_PIE_CORES = ['#1f7a52','#2f9468','#a3763a','#b3261e','#0d5c3a','#85978c','#22875a','#dde5e0'];
function apexPieHtml(ranking){
  const items = ranking.items;
  const total = items.reduce((s,it)=>s+Math.abs(it.value),0) || 1;
  let acc = 0;
  const stops = items.map((it,i)=>{
    const p0 = acc/total*100; acc += Math.abs(it.value); const p1 = acc/total*100;
    return `${APEX_PIE_CORES[i%APEX_PIE_CORES.length]} ${p0}% ${p1}%`;
  });
  const legenda = items.map((it,i)=>{
    const pct = (Math.abs(it.value)/total*100).toFixed(1);
    return `<div class="apex-pie-leg-row"><span class="apex-pie-sw" style="background:${APEX_PIE_CORES[i%APEX_PIE_CORES.length]}"></span><span class="apex-pie-leg-lbl">${apexEsc(it.label)}</span><span class="apex-pie-leg-val">${pct}%</span></div>`;
  }).join('');
  return `<div class="apex-pie-wrap"><div class="apex-pie" style="background:conic-gradient(${stops.join(',')})"></div><div class="apex-pie-legend">${legenda}</div></div>`;
}
function apexRankingHtml(ranking){
  if (!ranking || !ranking.items || !ranking.items.length) return '';
  const corpo = ranking.tipo==='pizza' ? apexPieHtml(ranking) : (function(){
    const max = Math.max.apply(null, ranking.items.map(x=>Math.abs(x.value))) || 1;
    return ranking.items.map(it=>{
      const pct = Math.round(Math.abs(it.value)/max*100);
      const valTxt = typeof it.value==='number' ? it.value.toLocaleString('pt-BR',{maximumFractionDigits:0}) : it.value;
      return `<div class="apex-rank-row"><span class="apex-rank-lbl">${apexEsc(it.label)}</span><div class="apex-rank-bar-bg"><div class="apex-rank-bar-fg" style="width:${pct}%"></div></div><span class="apex-rank-val">${apexEsc(valTxt)}</span></div>`;
    }).join('');
  })();
  return `<div class="apex-rank"><div class="apex-rank-title">${apexEsc(ranking.titulo)}</div>${corpo}</div>`;
}
function apexSlideHtml(s){
  let inner = '';
  if (s.kind==='capa'){
    inner = `<h1>${apexEsc(s.titulo)}</h1><p class="apex-sub">Escopo: <b>${apexEsc(s.escopoLabel)}</b> · Período: <b>${apexEsc(s.periodoLabel)}</b></p><p class="apex-meta">Gerado em ${apexEsc(s.geradoEm)}</p>`;
  } else if (s.kind==='agenda'){
    inner = `<h2>${apexEsc(s.titulo)}</h2><ul class="apex-agenda">${s.itens.map(it=>`<li>• ${apexEsc(it)}</li>`).join('')}</ul>`;
  } else if (s.kind==='resumo'){
    const kpisHtml = (s.kpis||[]).map(k=>`<div class="apex-kpi"><div class="apex-kpi-lbl">${apexEsc(k.label)}</div><div class="apex-kpi-val">${apexEsc(k.value)}</div>${k.delta&&k.delta.texto?`<div class="apex-kpi-delta ${k.delta.bom===true?'up':k.delta.bom===false?'dn':''}">${apexEsc(k.delta.texto)}</div>`:''}</div>`).join('');
    const rankHtml = apexRankingHtml(s.ranking);
    const notaHtml = (s.notas&&s.notas.length) ? `<p class="apex-nota">${s.notas.map(apexEsc).join(' ')}</p>` : '';
    inner = `<h2>${apexEsc(s.titulo)}</h2><div class="apex-kpigrid">${kpisHtml}</div>${rankHtml}${notaHtml}`;
  } else if (s.kind==='tabela'){
    inner = `<h2>${apexEsc(s.titulo)}</h2><div class="apex-tbl-wrap"><table class="apex-tbl"><thead><tr>${s.headers.map(h=>`<th>${apexEsc(h)}</th>`).join('')}</tr></thead><tbody>${s.rows.map((r,i)=>`<tr${i===s.totalRowIdx?' class="apex-tbl-total"':''}>${r.map(c=>`<td>${apexColorirCelula(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else if (s.kind==='insights'){
    inner = `<h2>${apexEsc(s.titulo)}</h2>${(s.itens||[]).map(it=>`<div class="apex-insight"><span class="apex-insight-sev ${apexEsc((it.severidade||'').toLowerCase())}">${apexEsc(it.severidade||'')}</span><div class="apex-insight-tit">${apexEsc(it.titulo)}</div><div class="apex-insight-det">${apexEsc(it.detalhe||'')}</div></div>`).join('')}`;
  } else if (s.kind==='fechamento'){
    inner = `<h2>${apexEsc(s.titulo)}</h2>${(s.itens||[]).map(it=>`<div class="apex-proximo"><div class="apex-proximo-lbl">▸ ${apexEsc(it.label)}</div><div class="apex-proximo-txt">${apexEsc(it.texto)}</div></div>`).join('')}`;
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

// ── DASHBOARD EXECUTIVO ──────────────────────────────────────────────────
// Aba de ENTRADA do portal: síntese de nível diretoria dos números mais
// importantes de TODAS as abas, pensada para leitura rápida e tomada de
// decisão — não duplica o detalhe de nenhuma aba, só agrega o que já existe
// (com profundidade real por Categoria/Gerente, não só um resumo superficial).
//
// Só LEITURA: reaproveita os mesmos extractors de apresentacao.js (que já
// leem, sem nunca escrever, os números prontos de cada aba), as mesmas
// funções puras de app.js (objMetaGeralFor/objRealGeralFor/effectiveGerentes
// etc. — as mesmas que montam a tabela "Meta x Realizado por Gerente" da aba
// Acompanhamento Objetivos) e os mesmos helpers de formatação/gráfico
// (fF/fN/fPct/mkChart/C/P/atingBadge/deltaPillSmall). Nenhum número é
// recalculado do zero aqui — satisfaz "verifique a veracidade dos números,
// não invente números" e "não pode alterar nada do que já foi feito nas
// abas existentes" (nada neste arquivo escreve em DOM/variável de outra aba).
//
// Convenção de cor: AQUI é o padrão NATIVO do portal (verde/vermelho via
// .kpi-delta up/dn e .risk-card cr/al/me/bx) — o azul/vermelho de
// APEX_COLORS é uma convenção pedida especificamente só para a aba
// Apresentação Executiva, não para esta.

// Mapeia o texto de severidade (badge) dos cards de Riscos & Oportunidades
// pra classe de borda do .risk-card — mesmo vocabulário de roCard()/
// roOportCard() em app.js (CRÍTICO/ALTO/-outro-/OPORTUNIDADE).
function dashRiskClass(sev){
  const s = (sev||'').toUpperCase();
  if (s === 'CRÍTICO') return 'cr';
  if (s === 'ALTO') return 'al';
  if (s === 'OPORTUNIDADE') return 'bx';
  return 'me';
}

function dashKpiHTML(k, i){
  const delta = (k.delta && k.delta.pct != null) ? `<span class="kpi-delta ${k.delta.bom ? 'up' : 'dn'}">${k.delta.texto}</span>` : '';
  return `<div class="kpi k${i % 7}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.label}</div><div class="kpi-val">${k.value}</div>${delta}${k.extra||''}</div>`;
}

function dashSemDado(msg){ return `<div class="alert" style="grid-column:1/-1">⚠ ${msg}</div>`; }

// Mini-gráfico de linha inline (SVG puro, sem Chart.js) — "big number" sempre
// acompanhado de tendência (boa prática de dashboard executivo: um número
// isolado não diz se é bom ou ruim sem o contexto da série). stroke via
// style (não atributo) pra herdar var(--acc) nos dois temas.
function dashSparklineSVG(values){
  const vals = (values||[]).filter(v=>v!=null);
  if (vals.length<2) return '';
  const w=110, h=28;
  const min = Math.min(...vals), max = Math.max(...vals), range = (max-min)||1;
  const pts = vals.map((v,i)=>`${(i/(vals.length-1)*w).toFixed(1)},${(h-((v-min)/range*h)).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;margin-top:6px" preserveAspectRatio="none"><polyline points="${pts}" fill="none" style="stroke:var(--acc);stroke-width:2;stroke-linecap:round;stroke-linejoin:round"/></svg>`;
}

// Veredito executivo (resumo de 1 frase + semáforo) — boa prática de
// dashboard de diretoria: status agregado único, visível sem rolar a tela,
// nunca inventado — construído só a partir de 2 números já calculados em
// outro lugar: (1) % da Meta Geral que a Tendência de fechamento atinge
// (apexExtractObjetivos().raw, aditivo) e (2) Δ de Receita vs. mesmo período
// do ano anterior (apexExtractVisaoGeral().kpis[0].delta). Quando nenhum dos
// dois está disponível (ex.: período sem meta cadastrada), diz isso
// explicitamente em vez de arriscar um veredito sem base.
function dashVeredito(visao, obj){
  const atingTend = (obj && obj.raw && obj.raw.totalMetaCat>0) ? (obj.raw.totalTrend/obj.raw.totalMetaCat*100) : null;
  const rDelta = (visao && visao.kpis[0] && visao.kpis[0].delta && visao.kpis[0].delta.pct!=null) ? visao.kpis[0].delta : null;
  if (atingTend==null && !rDelta) return { status:'a', label:'Atenção', texto:'Sem dado suficiente para um veredito automático neste período/recorte — ver Meta x Realizado e Visão Geral abaixo.' };
  let status, label, fraseMeta;
  if (atingTend!=null){
    status = atingTend>=100 ? 'g' : (atingTend>=90 ? 'a' : 'r');
    label = atingTend>=100 ? 'Acima da Meta' : (atingTend>=90 ? 'Atenção' : 'Abaixo da Meta');
    const rotulo = atingTend>=100 ? 'ACIMA da meta' : (atingTend>=90 ? 'PRÓXIMA da meta' : 'ABAIXO da meta');
    fraseMeta = `Tendência de fechamento ${rotulo} (${atingTend.toFixed(1)}% da Meta Geral)`;
  } else {
    // Sem meta cadastrada neste modo (ex.: Objetivos "datas exatas") — o
    // selo não pode falar de "meta" sem meta nenhuma; usa só a direção da
    // Receita vs. ano anterior.
    status = rDelta.bom ? 'g' : 'r';
    label = rDelta.bom ? 'Receita em Alta' : 'Receita em Queda';
    fraseMeta = 'Sem meta cadastrada para este período/recorte para comparar a tendência';
  }
  const fraseYoy = rDelta ? ` · Receita ${rDelta.bom?'cresceu':'caiu'} ${Math.abs(rDelta.pct).toFixed(1)}% vs. mesmo período do ano anterior` : '';
  return { status, label, texto: fraseMeta + fraseYoy };
}

// Renderizador genérico de tabela {titulo, headers, rows, totalRow, nota?}
// — usado pelas tabelas por Categoria, por Gerente e pelo ranking de Piores
// Margens. Células já vêm formatadas (podem conter HTML de deltaPillSmall/
// atingBadge, igual ao resto do portal) — por isso nunca são escapadas aqui.
// `nota` (opcional): linha de rodapé do título, pra avisos de metodologia
// (ex.: "Tendência não existe neste nível") sem precisar de outro elemento.
function dashTableCard(t){
  if (!t || !t.rows || !t.rows.length) return '';
  const totalHTML = t.totalRow
    ? `<tr style="font-weight:700"><td class="tn">${t.totalRow[0]}</td>${t.totalRow.slice(1).map(c=>`<td class="tv">${c}</td>`).join('')}</tr>`
    : '';
  const notaHTML = t.nota ? `<div class="card-sub">${t.nota}</div>` : '';
  return `<div class="card" style="margin-bottom:14px"><div class="card-h"><div><div class="card-title">${t.titulo}</div>${notaHTML}</div></div><div class="tbl-wrap"><table>
    <thead><tr>${t.headers.map((h,i)=>`<th${i>0?' class="tv"':''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${t.rows.map(r=>`<tr><td class="tn">${r[0]}</td>${r.slice(1).map(c=>`<td class="tv">${c}</td>`).join('')}</tr>`).join('')}${totalHTML}</tbody>
  </table></div></div>`;
}

// Badge de % Tendência vs. Meta (atingBadge já reusa as mesmas cores verde/
// âmbar/vermelho de % Atingimento) — "—" cinza quando a categoria não tem
// meta cadastrada (meta=0), nunca divide por zero.
function dashAtingTend(trend, meta){
  return (meta!=null && meta>0) ? atingBadge(trend/meta*100) : '<span style="color:var(--t3)">—</span>';
}

// Badge de comparação em PONTOS PERCENTUAIS (não % relativo) entre dois
// percentuais de atingimento já prontos — mesmo racional de apexDeltaPP
// (apresentacao.js): +3,2 p.p. é "3,2 pontos a mais", nunca "3,2% a mais".
function dashPPBadge(atual, ant){
  if (atual==null || ant==null) return '<span style="color:var(--t3)">—</span>';
  const pp = apexDeltaPP(atual, ant);
  return `<span class="kpi-delta ${pp.bom?'up':'dn'}">${pp.texto}</span>`;
}

// % Tendência deste ano (badge normal) + comparação em p.p. contra "% que o
// Realizado do ANO ANTERIOR representou da META DO ANO ANTERIOR" (mesmos
// meses) — só calculável no TOTAL GERAL (a Meta do ERP não tem grão por
// Categoria no ano anterior, só Gerente/Supervisor/Vendedor — por isso as
// linhas de categoria usam só dashAtingTend, sem o p.p.).
function dashAtingTendTotalComAnoAnt(trend, meta, prevReal, prevMeta){
  const badge = dashAtingTend(trend, meta);
  if (!(meta>0) || prevMeta==null || !(prevMeta>0) || prevReal==null) return badge;
  const pctAtual = trend/meta*100, pctAnt = prevReal/prevMeta*100;
  return `${badge} ${dashPPBadge(pctAtual, pctAnt)}`;
}

// Meta (Faturamento) e Meta Cash Margem do ANO ANTERIOR, somadas nos mesmos
// Gerentes/meses da aba — objPrevMetaGeralFor já existe em app.js (mesma
// fonte usada pela coluna "Δ Meta" da tabela nativa de Gerente/Supervisor/
// Vendedor em Acompanhamento Objetivos); dashPrevMetaValRentFor só espelha a
// MESMA leitura só que no campo meta_valrentabilidade (Cash Margem), que não
// tinha uma função "prev" própria ainda — mesmo objeto já carregado
// (prev.meta.por_mes[mês][gerente][nome]), nenhum dado novo buscado.
function dashPrevMetaValRentFor(prev, level, name, mesKey){
  if (!prev || !prev.meta) return null;
  const m = prev.meta.por_mes && prev.meta.por_mes[mesKey] && prev.meta.por_mes[mesKey][level] && prev.meta.por_mes[mesKey][level][name];
  return m ? (m.meta_valrentabilidade||0) : null;
}
function dashObjPrevMetaValRentGeralFor(prev, level, name, meses){
  if (!prev) return null;
  let sum=0, any=false;
  meses.forEach(mes=>{ const v=dashPrevMetaValRentFor(prev, level, name, String(mes)); if(v!=null){sum+=v; any=true;} });
  return any?sum:null;
}
function dashMetaAnoAnterior(){
  if (typeof curPeriod !== 'function' || typeof objMesesSelecionados !== 'function') return null;
  const d = curPeriod();
  if (!d || !d.meta) return null;
  const prev = (typeof prevPeriod === 'function') ? prevPeriod() : null;
  if (!prev || !prev.meta) return null;
  const meses = objMesesSelecionados();
  if (!meses.length) return null;
  const effGer = (typeof effectiveGerentes === 'function') ? effectiveGerentes(d) : null;
  const nomes = Object.keys(d.meta.por_gerente || {}).filter(n => !effGer || effGer.has(n));
  if (!nomes.length) return null;
  let totalMeta = 0, totalMetaCash = 0, any = false;
  nomes.forEach(n=>{
    const m = objPrevMetaGeralFor(prev, 'gerente', n, meses);
    if (m!=null){ totalMeta += m; any = true; }
    const mc = dashObjPrevMetaValRentGeralFor(prev, 'gerente', n, meses);
    if (mc!=null) totalMetaCash += mc;
  });
  return any ? { prevTotalMetaCat: totalMeta, prevTotalMetaCash: totalMetaCash } : null;
}

// "Meta x Realizado por Gerente" — MESMAS funções puras que montam a tabela
// homônima na aba Acompanhamento Objetivos (app.js: objMetaGeralFor/
// objRealGeralFor/objPrevRealGeralFor/objPrevMetaGeralFor/effectiveGerentes),
// só sem o toggle de cascata (aqui é síntese, o detalhe por Gerente/
// Supervisor/Vendedor fica na aba de origem). "Δ p.p." usa a META do ano
// anterior (objPrevMetaGeralFor, mesma fonte da coluna "Δ Meta" nativa) —
// por isso aqui, diferente da tabela por Categoria, o p.p. existe linha a
// linha: Gerente É o grão real da meta do ano anterior no ERP.
function dashGerentesTable(){
  if (typeof curPeriod !== 'function' || typeof objMesesSelecionados !== 'function') return null;
  const d = curPeriod();
  if (!d || !d.meta) return null;
  const prev = (typeof prevPeriod === 'function') ? prevPeriod() : null;
  const meses = objMesesSelecionados();
  if (!meses.length) return null;
  const effGer = (typeof effectiveGerentes === 'function') ? effectiveGerentes(d) : null;
  const nomes = Object.keys(d.meta.por_gerente || {}).filter(n => !effGer || effGer.has(n));
  if (!nomes.length) return null;
  const linhas = nomes.map(n => {
    const meta = objMetaGeralFor(d, 'gerente', n, meses);
    const real = objRealGeralFor(d, 'gerente', n, meses);
    const prevReal = objPrevRealGeralFor(prev, 'gerente', n, meses);
    const prevMeta = objPrevMetaGeralFor(prev, 'gerente', n, meses);
    const ating = meta>0 ? real/meta*100 : null;
    const atingAnt = (prevMeta>0 && prevReal!=null) ? prevReal/prevMeta*100 : null;
    return { nome:n, meta, real, prevReal, prevMeta, ating, atingAnt };
  }).sort((a,b)=>b.meta-a.meta);
  const totalMeta = linhas.reduce((s,l)=>s+l.meta,0);
  const totalReal = linhas.reduce((s,l)=>s+l.real,0);
  const totalPrevReal = linhas.every(l=>l.prevReal!=null) ? linhas.reduce((s,l)=>s+l.prevReal,0) : null;
  const totalPrevMeta = linhas.every(l=>l.prevMeta!=null) ? linhas.reduce((s,l)=>s+l.prevMeta,0) : null;
  const totalAting = totalMeta>0 ? totalReal/totalMeta*100 : null;
  const totalAtingAnt = (totalPrevMeta>0 && totalPrevReal!=null) ? totalPrevReal/totalPrevMeta*100 : null;
  return {
    titulo: `Meta x Realizado por Gerente (${linhas.length})`,
    nota: 'Tendência de Fechamento só existe no nível empresa (não recortável por Gerente/Supervisor/Vendedor — ver "% Tendência" em Meta x Realizado — Geral, acima). "Δ p.p." compara % Atingimento deste ano vs. % que o Realizado do ano anterior representou da Meta do ano anterior (mesmo Gerente, mesmos meses).',
    headers: ['Gerente','Meta','Realizado','Ano Anterior','Δ vs Ano Ant.','% Atingimento','Δ p.p. vs Ano Ant.'],
    rows: linhas.map(l=>[l.nome, fF(l.meta), fF(l.real), l.prevReal!=null?fF(l.prevReal):'sem base', deltaPillSmall(l.real, l.prevReal), atingBadge(l.ating), dashPPBadge(l.ating, l.atingAnt)]),
    totalRow: ['TOTAL GERAL', fF(totalMeta), fF(totalReal), totalPrevReal!=null?fF(totalPrevReal):'sem base', deltaPillSmall(totalReal, totalPrevReal), atingBadge(totalAting), dashPPBadge(totalAting, totalAtingAnt)],
  };
}

// "Faturamento por Categoria" e "Cash Margem por Categoria" — MESMOS dados
// de apexExtractObjetivos().raw.catRowsData (nunca recalculado), só que aqui
// ganham a coluna "% Tendência" (Tendência ÷ Meta) que as tabelas da
// Apresentação Executiva não têm — tabelas separadas pra não alterar em nada
// o que a Apresentação Executiva já gera (PPTX/HTML continuam lendo só
// `kpis`/`tables`/`ranking`, nunca `raw`). O TOTAL GERAL também ganha o "Δ
// p.p." vs. ano anterior (raw.prevTotalMetaCat/Cash, aditivos via
// dashMetaAnoAnterior) — as linhas de categoria não, porque a Meta do ano
// anterior só existe por Gerente/Supervisor/Vendedor no ERP, nunca por
// Categoria (ver nota abaixo).
function dashCategoriaFaturamentoTable(raw){
  const cats = raw.catRowsData || [];
  if (!cats.length) return null;
  return {
    titulo: 'Faturamento por Categoria',
    nota: raw.prevTotalMetaCat!=null ? '"Δ p.p." no TOTAL GERAL compara % Tendência deste ano vs. % que o Realizado do ano anterior representou da Meta do ano anterior — só no total (a Meta do ERP não tem grão por Categoria no ano anterior, só por Gerente/Supervisor/Vendedor).' : undefined,
    headers: ['Categoria','Meta','Realizado','Tendência','% Tendência','Ano Anterior','Δ Tend. vs Ano Ant.'],
    rows: cats.map(c=>[c.nome, fF(c.meta), fF(c.real), fF(c.trend), dashAtingTend(c.trend,c.meta), c.prevReal!=null?fF(c.prevReal):'sem base', apexDeltaTxt(c.trend,c.prevReal).texto]),
    totalRow: ['TOTAL GERAL', fF(raw.totalMetaCat), fF(raw.totalRealCat), fF(raw.totalTrend), dashAtingTendTotalComAnoAnt(raw.totalTrend,raw.totalMetaCat,raw.prevTotalRealCat,raw.prevTotalMetaCat), raw.prevTotalRealCat!=null?fF(raw.prevTotalRealCat):'sem base', apexDeltaTxt(raw.totalTrend,raw.prevTotalRealCat).texto],
  };
}
function dashCategoriaCashTable(raw){
  const cats = raw.catRowsData || [];
  if (!cats.length) return null;
  return {
    titulo: 'Cash Margem por Categoria',
    nota: raw.prevTotalMetaCash!=null ? '"Δ p.p." no TOTAL GERAL compara % Tendência Cash Margem deste ano vs. % que o Cash Margem do ano anterior representou da Meta Cash Margem do ano anterior — só no total (mesmo motivo acima).' : undefined,
    headers: ['Categoria','Meta Cash Margem','Cash Margem','Tendência Cash Margem','% Tendência','Ano Anterior','Δ vs Ano Ant.'],
    rows: cats.map(c=>[c.nome, c.metaCash>0?fF(c.metaCash):'—', fF(c.cash), fF(c.trendCash), dashAtingTend(c.trendCash,c.metaCash), c.prevCash!=null?fF(c.prevCash):'sem base', apexDeltaTxt(c.trendCash,c.prevCash).texto]),
    totalRow: ['TOTAL GERAL', raw.totalMetaCash>0?fF(raw.totalMetaCash):'—', fF(raw.totalCash), fF(raw.totalTrendCash), dashAtingTendTotalComAnoAnt(raw.totalTrendCash,raw.totalMetaCash,raw.prevTotalCash,raw.prevTotalMetaCash), raw.prevTotalCash!=null?fF(raw.prevTotalCash):'sem base', apexDeltaTxt(raw.totalTrendCash,raw.prevTotalCash).texto],
  };
}

function renderDashboard(){
  const subEl = document.getElementById('dash-sub'), metaEl = document.getElementById('dash-meta');
  const ctx = (typeof apexContextoAtivo === 'function') ? apexContextoAtivo() : { escopoLabel: '—', periodoLabel: '—' };
  if (subEl) subEl.textContent = ctx.periodoLabel;
  if (metaEl) metaEl.textContent = ctx.escopoLabel;

  // 0) Dados-base usados em mais de um bloco abaixo — calculados uma vez só.
  const visao = (typeof apexExtractVisaoGeral === 'function') ? apexExtractVisaoGeral() : null;
  const obj = (typeof apexExtractObjetivos === 'function') ? apexExtractObjetivos() : null;
  const compRes = (typeof renderComp === 'function') ? renderComp() : null;
  const mesesReceita = (compRes && compRes.mesesReceita) || [];
  // Meta (Faturamento/Cash Margem) do ANO ANTERIOR, mesclada em obj.raw — só
  // existe no modo mensal (obj.raw vem de apexExtractObjetivosMensal); no modo
  // "datas exatas" obj.raw é undefined e isso não roda (nada a mesclar).
  if (obj && obj.raw){
    const prevMetaTotal = dashMetaAnoAnterior();
    if (prevMetaTotal) Object.assign(obj.raw, prevMetaTotal);
  }

  // 0b) Veredito executivo — primeira coisa que a tela mostra (boa prática de
  // dashboard de diretoria: status agregado + frase, sem precisar rolar).
  const veredEl = document.getElementById('dash-veredito');
  if (veredEl){
    const vd = dashVeredito(visao, obj);
    const etlInfo = (typeof DIAG !== 'undefined' && DIAG.etl && DIAG.etl.atualizadoEm) ? new Date(DIAG.etl.atualizadoEm).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}) : null;
    veredEl.innerHTML = `<span class="dash-verdict-badge ${vd.status}">${vd.label}</span>
      <div class="dash-verdict-text-wrap"><div class="dash-verdict-txt">${vd.texto}</div><div class="dash-verdict-meta">Escopo: ${ctx.escopoLabel} · Período: ${ctx.periodoLabel}${etlInfo?` · Dados atualizados em ${etlInfo}`:''}</div></div>`;
  }

  // 1) KPIs-herói — mesmos números/deltas da Visão Geral. O 1º card (Receita,
  // o "big number") ganha uma mini-tendência (sparkline) com a mesma série
  // mensal do gráfico abaixo — um número isolado não diz se é bom ou ruim
  // sem o contexto da série (boa prática de dashboard executivo).
  const heroEl = document.getElementById('dash-kpis-hero');
  if (heroEl){
    if (visao){
      // BUG CORRIGIDO: com filtro de Gerente/Supervisor/Vendedor/etc., estes
      // KPIs vêm do recorte do ANO (ensureAnoScope/renderVisao) — enquanto ele
      // está em voo ou se falhar (timeout do banco, por exemplo), os valores
      // ficam todos zerados. A aba nativa Visão Geral já avisava isso; aqui
      // os cards só mostravam R$ 0 em silêncio. `visao.avisos` carrega o
      // mesmo aviso (idêntico à aba nativa), exibido antes dos cards.
      const avisosHtml = (visao.notas||[]).map(b=>`<div class="alert" style="grid-column:1/-1">${b}</div>`).join('');
      const spark = mesesReceita.length>=2 ? dashSparklineSVG(mesesReceita.map(m=>m.atual)) : '';
      const kpis = visao.kpis.map((k,i)=> i===0 ? Object.assign({}, k, { extra: spark }) : k);
      heroEl.innerHTML = avisosHtml + kpis.map(dashKpiHTML).join('');
    } else {
      heroEl.innerHTML = dashSemDado('Sem dados de Visão Geral para o período/escopo selecionado.');
    }
  }

  // 2) Meta x Realizado x Tendência — geral da empresa (Acompanhamento
  // Objetivos). Todo campo com Meta+Realizado ganha o valor em R$ do Ano
  // Anterior (mesmos meses) e, pra Tendência/Cash Margem Tendência, a
  // comparação em PONTOS PERCENTUAIS entre "% Tendência deste ano" e "% que
  // o Realizado do ano anterior representou da Meta do ano anterior" (cada
  // ano comparado com a SUA PRÓPRIA meta, não a meta deste ano).
  const metaGridEl = document.getElementById('dash-kpis-meta');
  if (metaGridEl){
    if (obj){
      const r = obj.raw || {};
      const pctAtual = (r.totalMetaCat>0) ? r.totalTrend/r.totalMetaCat*100 : null;
      const pctAnt = (r.prevTotalMetaCat>0 && r.prevTotalRealCat!=null) ? r.prevTotalRealCat/r.prevTotalMetaCat*100 : null;
      const pctAtualCash = (r.totalMetaCash>0) ? r.totalTrendCash/r.totalMetaCash*100 : null;
      const pctAntCash = (r.prevTotalMetaCash>0 && r.prevTotalCash!=null) ? r.prevTotalCash/r.prevTotalMetaCash*100 : null;
      const kpis = obj.kpis.map(k=>{
        if (k.label==='Meta Geral')
          return Object.assign({}, k, { extra: r.prevTotalMetaCat!=null ? `<div class="kpi-note">Ano Anterior: ${fF(r.prevTotalMetaCat)} ${deltaPillSmall(r.totalMetaCat, r.prevTotalMetaCat)}</div>` : '' });
        if (k.label==='Realizado')
          return Object.assign({}, k, { extra: r.prevTotalRealCat!=null ? `<div class="kpi-note">Ano Anterior (mesmos meses): ${fF(r.prevTotalRealCat)}</div>` : '' });
        if (k.label==='Tendência de Fechamento' && r.totalMetaCat>0)
          return Object.assign({}, k, { extra:
            `<div class="kpi-note">% da Meta Geral: ${dashAtingTend(r.totalTrend, r.totalMetaCat)}</div>`+
            `<div class="kpi-note">Ano Anterior: ${r.prevTotalRealCat!=null?fF(r.prevTotalRealCat):'sem base'}${pctAnt!=null?` (${pctAnt.toFixed(1)}% da meta do ano anterior)`:''} ${dashPPBadge(pctAtual, pctAnt)}</div>` });
        if (k.label==='Cash Margem (Tendência)' && r.totalMetaCash>0)
          return Object.assign({}, k, { extra:
            `<div class="kpi-note">% da Meta Cash Margem: ${dashAtingTend(r.totalTrendCash, r.totalMetaCash)}</div>`+
            `<div class="kpi-note">Ano Anterior: ${r.prevTotalCash!=null?fF(r.prevTotalCash):'sem base'}${pctAntCash!=null?` (${pctAntCash.toFixed(1)}% da meta do ano anterior)`:''} ${dashPPBadge(pctAtualCash, pctAntCash)}</div>` });
        return k;
      });
      metaGridEl.innerHTML = kpis.map(dashKpiHTML).join('');
    } else {
      metaGridEl.innerHTML = dashSemDado('Sem meta cadastrada para este período/recorte — ver aba Acompanhamento Objetivos.');
    }
  }

  // 3) Tendência mensal de Receita (reaproveita a mesma série do gráfico
  // cCompMes, exposta por renderComp() em mesesReceita) + Mix por Categoria
  // (mesmo ranking da Visão Geral).
  // Mesma limitação JÁ EXISTENTE na aba Comparativos: o gráfico por mês vem do
  // cubo bruto do ano (buildYearPeriod), que não cruza com Gerente/Supervisor/
  // Vendedor — é sempre nível empresa. Como o resto do Dashboard FICA recortado
  // pelo filtro ativo, um aviso evita o diretor interpretar o gráfico como
  // escopado quando não é.
  const mesNoteEl = document.getElementById('dashMesNote');
  if (mesNoteEl) mesNoteEl.textContent = (typeof hierLevelActive === 'function' && hierLevelActive())
    ? 'Série sempre em nível empresa — mesma limitação da aba Comparativos (o cubo por mês não cruza com Gerente/Supervisor/Vendedor)'
    : '';
  if (mesesReceita.length){
    mkChart('cDashMes', { type:'line', data:{ labels: mesesReceita.map(m=>m.label), datasets:[
      { label:'Receita Atual', data: mesesReceita.map(m=>m.atual), borderColor:C.acc, backgroundColor:C.acc+'22', tension:.3, fill:true },
      { label:'Ano Anterior', data: mesesReceita.map(m=>m.anterior), borderColor:C.t2, backgroundColor:'transparent', borderDash:[4,4], tension:.3 },
    ]}, options:{ responsive:true, plugins:{ legend:{position:'top',labels:{boxWidth:10,font:{size:10}}}, tooltip:{callbacks:{label:c=>' '+c.dataset.label+': '+fF(c.raw)}} }, scales:{ y:{ ticks:{ callback:v=>fM(v) } } } } });
  } else if (charts['cDashMes']) { charts['cDashMes'].destroy(); delete charts['cDashMes']; }

  const catItems = (visao && visao.ranking && visao.ranking.items) || [];
  if (catItems.length){
    mkChart('cDashCat', { type:'doughnut', data:{ labels: catItems.map(c=>c.label), datasets:[{ data: catItems.map(c=>c.value), backgroundColor: catItems.map((_,i)=>P[i%P.length]) }] },
      options:{ responsive:true, plugins:{ legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}, tooltip:{callbacks:{label:c=>' '+c.label+': '+fF(c.raw)}} } } });
  } else if (charts['cDashCat']) { charts['cDashCat'].destroy(); delete charts['cDashCat']; }

  // 4) Desempenho por Categoria — Faturamento/Cash Margem reconstruídas aqui
  // (dashCategoriaFaturamentoTable/CashTable) a partir de obj.raw.catRowsData
  // pra incluir a coluna "% Tendência" sem alterar as tabelas que a aba
  // Apresentação Executiva usa (obj.tables, intocado). Margem%/Positivação e
  // Bonificação (sem Meta em R$ — % Tendência não se aplica) continuam vindo
  // das mesmas obj.tables de sempre. No modo "Personalizado (datas exatas)"
  // obj.raw não existe (não há Meta nesse modo) — cai pro obj.tables original.
  const catTablesEl = document.getElementById('dash-cat-tables');
  if (catTablesEl){
    const r = obj && obj.raw;
    let tabelas;
    if (r && r.catRowsData && r.catRowsData.length){
      tabelas = [dashCategoriaFaturamentoTable(r), dashCategoriaCashTable(r)].concat((obj.tables||[]).slice(2));
    } else {
      tabelas = (obj && obj.tables) || [];
    }
    catTablesEl.innerHTML = tabelas.length ? tabelas.map(dashTableCard).join('') : dashSemDado('Sem detalhamento por categoria disponível para este período/recorte.');
  }

  // 5) Desempenho por Gerente
  const gerEl = document.getElementById('dash-gerentes');
  if (gerEl){
    const gerTable = dashGerentesTable();
    gerEl.innerHTML = gerTable ? dashTableCard(gerTable) : dashSemDado('Sem meta por Gerente disponível para este período/recorte.');
  }

  // 6) Classificação de Clientes (A–I) — concentração de receita, últimos 90 dias
  const abcd = (typeof apexExtractAbcd === 'function') ? apexExtractAbcd() : null;
  const abcdKpisEl = document.getElementById('dash-abcd-kpis'), abcdTableEl = document.getElementById('dash-abcd-table');
  if (abcdKpisEl) abcdKpisEl.innerHTML = abcd ? abcd.kpis.map(dashKpiHTML).join('') : dashSemDado('Sem classificação A–I disponível.');
  if (abcdTableEl) abcdTableEl.innerHTML = (abcd && abcd.tables[0]) ? dashTableCard(abcd.tables[0]) : '';

  // 7) Riscos & Oportunidades — LISTA COMPLETA, em duas colunas (igual à aba
  // de origem), não só um recorte "top 6" — é a visão de diretoria, tem que
  // mostrar todo o pipeline de risco/oportunidade mapeado no período.
  const ro = (typeof renderRiscoOport === 'function') ? renderRiscoOport() : null;
  const roSubEl = document.getElementById('dash-ro-sub');
  if (roSubEl) roSubEl.textContent = (ro && ro.scopeLabel) ? `Recortado por ${ro.scopeLabel} — mesma fonte da aba Riscos & Oportunidades` : 'Lista completa — mesma fonte da aba Riscos & Oportunidades';
  const riscosEl = document.getElementById('dash-riscos-list'), oportEl = document.getElementById('dash-oport-list');
  if (riscosEl) riscosEl.innerHTML = (ro && ro.riscos && ro.riscos.length) ? ro.riscos.map(x=>x.html).join('') : dashSemDado('Nenhum risco identificado para o escopo atual.');
  if (oportEl) oportEl.innerHTML = (ro && ro.oports && ro.oports.length) ? ro.oports.map(x=>x.html).join('') : dashSemDado('Nenhuma oportunidade identificada para o escopo atual.');

  // 8) Faixa de alertas operacionais — um KPI de cada aba de monitoramento
  const alertEl = document.getElementById('dash-alertas');
  if (alertEl){
    const cards = [];
    const vm = (typeof apexExtractVendedoresMeta === 'function') ? apexExtractVendedoresMeta() : null;
    if (vm){
      const abaixo = vm.kpis.find(k=>k.label==='Abaixo de R$150 mil/mês');
      if (abaixo) cards.push({ label:'Vendedores < R$150 mil/mês', value:abaixo.value, note:'ver aba Vendedores Abaixo da Meta' });
    }
    const inad = (typeof apexExtractInadimplencia === 'function') ? apexExtractInadimplencia() : null;
    if (inad){
      const saldo = inad.kpis.find(k=>k.label==='Saldo em Aberto');
      const venc = inad.kpis.find(k=>k.label==='Vencido há +1 Ano');
      if (saldo) cards.push({ label:'Inadimplência — Saldo em Aberto', value:saldo.value, note: venc ? venc.value+' vencido há +1 ano' : '' });
    }
    const sc = (typeof apexExtractClientesSemCompra === 'function') ? apexExtractClientesSemCompra() : null;
    if (sc){
      const c = sc.kpis.find(k=>k.label==='Clientes no Recorte');
      if (c) cards.push({ label:'Clientes sem Compra (60+ dias)', value:c.value });
    }
    const est = (typeof apexExtractEstoque === 'function') ? apexExtractEstoque() : null;
    if (est){
      const v = est.kpis.find(k=>k.label==='Valor de Estoque');
      const cov = est.kpis.find(k=>k.label==='Cobertura Média');
      if (v) cards.push({ label:'Estoque — Valor Total', value:v.value, note: cov ? 'Cobertura média: '+cov.value : '' });
    }
    alertEl.innerHTML = cards.length ? cards.map((k,i)=>
      `<div class="kpi k${i%7}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.label}</div><div class="kpi-val">${k.value}</div>${k.note?`<div class="kpi-note">${k.note}</div>`:''}</div>`
    ).join('') : dashSemDado('Sem dados operacionais disponíveis.');
  }

  // 9) Rankings — Top 5 Clientes/Vendedores por Receita + Top 10 Piores Margens
  // (mesma fonte da aba Rankings, inclusive o ranking de ofensores de margem,
  // que o Dashboard antes não mostrava).
  const rankRes = (typeof apexExtractRankings === 'function') ? apexExtractRankings() : null;
  const cliEl = document.getElementById('tDashRankCli'), vendEl = document.getElementById('tDashRankVend');
  const rankTableHTML = (t) => t ? `<thead><tr>${t.headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${t.rows.slice(0,5).map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>` : `<tbody><tr><td>sem dado disponível</td></tr></tbody>`;
  if (cliEl) cliEl.innerHTML = rankTableHTML(rankRes && rankRes.tables[0]);
  if (vendEl) vendEl.innerHTML = rankTableHTML(rankRes && rankRes.tables[1]);
  const ofensoresEl = document.getElementById('dash-rank-ofensores');
  if (ofensoresEl) ofensoresEl.innerHTML = (rankRes && rankRes.tables[2]) ? dashTableCard(rankRes.tables[2]) : '';

  // 10) Rodapé — mesmo escopo/período que o restante do portal já mostra
  const footEl = document.getElementById('dash-footer');
  if (footEl) footEl.textContent = `Fonte: 100% API do portal, mesmo cubo das demais abas · Escopo: ${ctx.escopoLabel} · Período: ${ctx.periodoLabel}`;
}

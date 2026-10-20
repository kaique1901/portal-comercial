// ── RESULTADOS DIÁRIOS ───────────────────────────────────────────────────
// Mesma fonte de dado da aba Sazonalidade — Dia da Semana (por_dia/
// por_dia_categoria, data real do pedido) — só que aqui cada DATA EXATA fica
// isolada (gráfico/tabela por dia e resumo por categoria), em vez de
// agregada por dia da semana. Só leitura: nunca escreve em DOM/variável de
// outra aba, nunca recalcula o que o cubo já entrega pronto.
//
// Janela padrão é o MÊS VIGENTE (período menor, foco no que está em curso
// agora) — "Últimos 90 dias"/"Semestre anterior" continuam disponíveis, e um
// 4º modo "Personalizado" permite pedir qualquer intervalo maior (inclusive
// cruzando vários semestres), reaproveitando janelaPorDiaMultiPeriodo()
// (app.js) — a mesma função que já mescla por_dia/por_dia_categoria de TODOS
// os semestres em cache, usada pelo modo "datas exatas" de Objetivos.
//
// O que este arquivo NÃO mostra, de propósito, por não existir no cubo:
// nº de pedidos por dia (o ETL só agrega SUM(Receita)/SUM(Custo) por data,
// nunca COUNT) e série diária exata de Supervisor/Vendedor (só Gerente tem
// cubo diário — mesma limitação já documentada em diaHierAvailable/app.js).
//
// Três cuidados de metodologia, descobertos testando com dado real:
// 1) "Hoje" quase sempre é um dia EM ANDAMENTO (o ETL roda em ciclos, não em
//    tempo real) — comparar a receita parcial de hoje com um dia fechado do
//    ano anterior sempre dá uma queda artificial. Por isso hoje nunca entra
//    no "Último dia fechado"/Melhor/Pior dia nem ganha Δ vs. ano anterior —
//    some em destaque à parte, só com o valor bruto (parcial).
// 2) "Mesmo dia do calendário 1 ano atrás" (mesmoDiaAnoAnterior, já usado em
//    Objetivos "datas exatas") é correto para SOMAR um intervalo, mas não
//    pra comparar 1 dia isolado: o deslocamento de 1-2 dias entre anos pode
//    cair numa Segunda-feira de um lado e num Domingo do outro — para uma
//    empresa que quase não vende aos domingos, isso gera deltas absurdos
//    (+200.000%). Aqui a comparação de 1 DIA usa o MESMO DIA DA SEMANA mais
//    próximo da mesma época do ano anterior (padrão de varejo); o resumo por
//    CATEGORIA soma a janela inteira (intervalo, não ponto único), onde a
//    data crua (mesmoDiaAnoAnterior) já é o critério correto — mesmo usado
//    em Objetivos "datas exatas".
// 3) POSITIVAÇÃO (clientes distintos) agora existe no cubo por DIA EXATO
//    (por_dia_categoria_clientes_cod[dia][categoria] — mesma técnica de
//    array_agg DISTINCT CodCli do ETL já usada no grão mensal, só que
//    agrupada por data em vez de por mês), nível empresa, sem recorte de
//    hierarquia pronto — confirmado em DashboardETLService/
//    DashboardRecorteService: hierarquia só existe via consulta AO VIVO
//    /recorte, amarrada a ST.per, não a esta janela. Por isso aqui a
//    Positivação: (a) é exata ao intervalo exibido (sem arredondar pra mês
//    civil, ao contrário do que valia antes desta mudança); (b) fica
//    indisponível (com nota explícita, nunca um número aproximado
//    silencioso) quando há filtro de Gerente/Supervisor/Vendedor/Cliente/
//    Canal/Status/Grupo ativo; (c) em cache ANTIGO (antes do ETL reprocessar
//    com a coluna nova), cai pro grão mensal civil que já existia, como
//    fallback — nunca quebra.

let DIARIO = { base: 'mes', dataIni: null, dataFim: null };
function onDiarioBaseChange(v){ DIARIO.base = v; renderDiario(); }
function onDiarioDataChange(){
  DIARIO.dataIni = document.getElementById('fDiarioDataIni').value || null;
  DIARIO.dataFim = document.getElementById('fDiarioDataFim').value || null;
  renderDiario();
}
function populateDiarioSubFiltro(){
  const wrap = document.getElementById('diarioSubFiltroWrap');
  if (!wrap) return;
  wrap.innerHTML = DIARIO.base==='custom' ? `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    <label style="font-size:11px;color:var(--t3)">De <input type="date" class="fsel-main" id="fDiarioDataIni" value="${DIARIO.dataIni||''}" onchange="onDiarioDataChange()"></label>
    <label style="font-size:11px;color:var(--t3)">até <input type="date" class="fsel-main" id="fDiarioDataFim" value="${DIARIO.dataFim||''}" onchange="onDiarioDataChange()"></label>
  </div>` : '';
}

const DIARIO_DOW_NOMES = {0:'Domingo',1:'Segunda',2:'Terça',3:'Quarta',4:'Quinta',5:'Sexta',6:'Sábado'};
function diarioNomeDow(iso){ return DIARIO_DOW_NOMES[new Date(iso+'T00:00:00').getDay()]; }
function diarioFmtData(iso){ const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }
// "Hoje" em data local (não UTC) — mesmo critério de businessDaysElapsed()
// (new Date().getDate()/getMonth()/getFullYear()), pra não desalinhar perto
// da meia-noite UTC (Brasil é UTC-3).
function diarioIsoLocal(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// Mesmo dia da semana, na mesma época do ano anterior — parte da data exata
// 1 ano atrás (mesmoDiaAnoAnterior, app.js) e ajusta até ±3 dias (uma volta
// completa da semana) até achar o dia com o MESMO dia-da-semana de `dateStr`.
// Sempre encontra (qualquer janela de 7 dias contém os 7 dias da semana uma
// vez cada).
function diarioMesmoDiaSemanaAnoAnt(dateStr){
  const base = mesmoDiaAnoAnterior(dateStr);
  const dowAlvo = new Date(dateStr+'T00:00:00').getDay();
  for (let delta=0; delta<=3; delta++){
    for (const sinal of (delta===0?[0]:[1,-1])){
      const d = new Date(base+'T00:00:00'); d.setDate(d.getDate()+delta*sinal);
      if (d.getDay()===dowAlvo) return d.toISOString().slice(0,10);
    }
  }
  return base;
}

// Janela da aba: delega às 3 bases já existentes em Sazonalidade
// (resolveSazonalidadeWindow) ou resolve um intervalo PERSONALIZADO (maior
// ou menor, à escolha do usuário), mesclando todos os semestres em cache —
// mesma função usada pelo modo "Personalizado (datas exatas)" de Objetivos.
function diarioResolveWindow(base, names){
  if (base !== 'custom') return resolveSazonalidadeWindow(base, names);
  const ini = DIARIO.dataIni, fim = DIARIO.dataFim;
  if (!ini || !fim || ini>fim){
    return { porDia:{}, porDiaCategoria:{}, iniStr:null, finStr:null, prevPorDia:{}, prevPorDiaCategoria:{}, prevIniStr:null, prevFinStr:null,
      label:'Selecione a data inicial e final (data inicial não pode ser depois da final).' };
  }
  const cur = janelaPorDiaMultiPeriodo(ini, fim, names);
  const iniPrev = mesmoDiaAnoAnterior(ini), fimPrev = mesmoDiaAnoAnterior(fim);
  const prevW = janelaPorDiaMultiPeriodo(iniPrev, fimPrev, names);
  return { porDia:cur.porDia, porDiaCategoria:cur.porDiaCategoria, iniStr:ini, finStr:fim,
    prevPorDia:prevW.porDia, prevPorDiaCategoria:prevW.porDiaCategoria, prevIniStr:iniPrev, prevFinStr:fimPrev,
    label:`Personalizado (${fmtBR(ini)} a ${fmtBR(fim)})` };
}

// Soma, por data, as categorias selecionadas no filtro global (ST.cat) a
// partir de porDiaCategoria — sem filtro ativo, devolve porDia como está
// (nenhum recálculo quando a categoria não está filtrada).
function diarioFiltrarCategorias(porDia, porDiaCategoria, cats){
  if (!cats || !cats.length) return porDia || {};
  const out = {};
  Object.keys(porDiaCategoria || {}).forEach(date=>{
    const catMap = porDiaCategoria[date];
    let r=0, c=0;
    cats.forEach(cat=>{ const v = catMap[cat]; if (v){ r+=v[0]||0; c+=v[1]||0; } });
    out[date] = [r, c];
  });
  return out;
}

// Todas as categorias que aparecem em algum dia da janela — base do resumo
// por categoria quando nenhum filtro de Categoria está ativo.
function diarioCategoriasNaJanela(porDiaCategoria){
  const set = new Set();
  Object.values(porDiaCategoria||{}).forEach(catMap=>Object.keys(catMap||{}).forEach(c=>set.add(c)));
  return Array.from(set);
}

// ── POSITIVAÇÃO (clientes distintos) ─────────────────────────────────────
// Grão de DIA EXATO (por_dia_categoria_clientes_cod[dia][categoria]), nível
// empresa, lendo direto de REAL_DATA (sem passar por curPeriod()/recorte —
// seguro só quando não há NENHUM filtro de hierarquia/cliente/canal/status/
// grupo ativo, ver diarioPositivacaoBloqueios). Une (Set) os códigos de
// TODOS os dias de [iniStr,finStr], em TODOS os semestres em cache que a
// janela toca (mesmo padrão de janelaPorDiaMultiPeriodo) — um cliente que
// comprou em vários dias/categorias da janela só conta 1x no total.
function diarioPositivacaoUniaoPorDia(iniStr, finStr){
  if (!iniStr || !finStr) return null;
  const setTotal = new Set();
  const setsPorCat = {};
  let algumDia = false;
  PERIOD_ORDER.forEach(key=>{
    const p = window.REAL_DATA && REAL_DATA[key];
    const cubo = p && p.por_dia_categoria_clientes_cod;
    if (!cubo) return;
    Object.keys(cubo).forEach(dt=>{
      if (dt<iniStr || dt>finStr) return;
      algumDia = true;
      const catMap = cubo[dt];
      Object.keys(catMap).forEach(cat=>{
        const s = setsPorCat[cat] || (setsPorCat[cat] = new Set());
        catMap[cat].forEach(cod=>{ s.add(cod); setTotal.add(cod); });
      });
    });
  });
  if (!algumDia) return null;
  const porCategoria = {};
  Object.keys(setsPorCat).forEach(cat=>{ porCategoria[cat] = setsPorCat[cat].size; });
  return { totalGeral: setTotal.size, porCategoria };
}
// Meses civis [{ano,mes}] tocados por [ini,fim] — só usado agora pelo
// FALLBACK (cache antigo, sem por_dia_categoria_clientes_cod ainda).
function diarioMesesTocados(iniStr, finStr){
  const out = [];
  if (!iniStr || !finStr) return out;
  let [anoI, mesI] = iniStr.split('-').map(Number);
  const [anoF, mesF] = finStr.split('-').map(Number);
  let ano=anoI, mes=mesI, guard=0;
  while ((ano<anoF || (ano===anoF && mes<=mesF)) && guard++<240){
    out.push({ano, mes});
    mes++; if (mes>12){ mes=1; ano++; }
  }
  return out;
}
// Fallback mensal (civil) — mesma lógica de antes desta mudança, só acionada
// quando NENHUM dia da janela tem por_dia_categoria_clientes_cod no cache
// (ETL ainda não reprocessou com a coluna nova).
function diarioPositivacaoUniaoPorMes(iniStr, finStr){
  const meses = diarioMesesTocados(iniStr, finStr);
  const setTotal = new Set();
  const setsPorCat = {};
  const mesesUsados = [];
  meses.forEach(({ano,mes})=>{
    const key = `${ano}_${mes<=6?1:2}`;
    const p = window.REAL_DATA && REAL_DATA[key];
    const mc = p && p.por_mes_categoria_clientes_cod && p.por_mes_categoria_clientes_cod[String(mes)];
    if (!mc) return;
    mesesUsados.push(`${MESES_NOME[mes]}/${ano}`);
    Object.keys(mc).forEach(cat=>{
      const s = setsPorCat[cat] || (setsPorCat[cat] = new Set());
      mc[cat].forEach(cod=>{ s.add(cod); setTotal.add(cod); });
    });
  });
  if (!mesesUsados.length) return null;
  const porCategoria = {};
  Object.keys(setsPorCat).forEach(cat=>{ porCategoria[cat] = setsPorCat[cat].size; });
  return { totalGeral: setTotal.size, porCategoria, mesesUsados, grao:'mes' };
}
// Ponto de entrada único: tenta o grão exato de DIA primeiro; só cai pro
// mensal se o cache ainda não tiver a coluna nova em NENHUM dia da janela.
function diarioPositivacao(iniStr, finStr){
  const porDia = diarioPositivacaoUniaoPorDia(iniStr, finStr);
  if (porDia) return Object.assign({ grao:'dia' }, porDia);
  return diarioPositivacaoUniaoPorMes(iniStr, finStr) || { totalGeral:null, porCategoria:{}, grao:'dia' };
}
// Positivação de 1 DIA EXATO isolado (não a janela inteira) — usado no hero
// "Último dia fechado" e na tabela de dias mais recentes. null quando o
// cache ainda não tem a coluna nova pra essa data (nunca aproxima por mês).
function diarioPositivacaoDia(dt){
  for (const key of PERIOD_ORDER){
    const p = window.REAL_DATA && REAL_DATA[key];
    const catMap = p && p.por_dia_categoria_clientes_cod && p.por_dia_categoria_clientes_cod[dt];
    if (!catMap) continue;
    const set = new Set();
    Object.values(catMap).forEach(cods=>cods.forEach(c=>set.add(c)));
    return set.size;
  }
  return null;
}
// Filtros que a Positivação NÃO consegue respeitar nesta leitura direta do
// cubo (todos, menos Categoria, que já é nativo da estrutura) — mesmo
// critério de activeFilterCount(), sem o próprio Categoria.
function diarioPositivacaoBloqueios(){
  const mapa = { ger:'Gerente', sup:'Supervisor', vend:'Vendedor', cli:'Cliente', canal:'Canal', status:'Status', grp:'Grupo' };
  return Object.keys(mapa).filter(k=>ST[k].length>0).map(k=>mapa[k]);
}
// Matriz "Clientes Atendidos (Positivação) por Dia × Categoria" — mesmo
// layout de diarioMatrizDiaCategoriaHTML (receita), mas cada célula é a
// CONTAGEM de códigos distintos daquele dia+categoria (já vem deduplicada do
// ETL, array_agg DISTINCT — não precisa de Set por célula); a coluna Total
// sim precisa de Set (um cliente pode comprar em 2+ categorias no mesmo dia
// e não pode ser contado 2x no total do dia).
function diarioMatrizPosDiaCategoriaHTML(iniStr, finStr, nomesCats, hojeStr, limite){
  if (!nomesCats.length || !iniStr || !finStr) return '';
  const cuboUnido = {};
  PERIOD_ORDER.forEach(key=>{
    const p = window.REAL_DATA && REAL_DATA[key];
    const cubo = p && p.por_dia_categoria_clientes_cod;
    if (!cubo) return;
    Object.keys(cubo).forEach(dt=>{ if (dt>=iniStr && dt<=finStr) cuboUnido[dt] = cubo[dt]; });
  });
  const dias = Object.keys(cuboUnido).sort().reverse().slice(0, limite);
  if (!dias.length) return '';
  const head = `<thead><tr><th>Data</th><th>Dia da Semana</th>${nomesCats.map(c=>`<th class="tv">${c}</th>`).join('')}<th class="tv">Total (únicos)</th></tr></thead>`;
  const body = dias.map(dt=>{
    const catMap = cuboUnido[dt] || {};
    const setTotal = new Set();
    const cells = nomesCats.map(cat=>{
      const cods = catMap[cat] || [];
      cods.forEach(c=>setTotal.add(c));
      return `<td class="tv">${cods.length>0?fN(cods.length):'<span style="color:var(--t3)">—</span>'}</td>`;
    }).join('');
    const ehHoje = dt===hojeStr;
    return `<tr><td class="tn">${diarioFmtData(dt)}${ehHoje?' <span class="kpi-note" style="display:inline">(hoje)</span>':''}</td><td>${diarioNomeDow(dt)}</td>${cells}<td class="tv" style="font-weight:700">${fN(setTotal.size)}</td></tr>`;
  }).join('');
  return head + `<tbody>${body}</tbody>`;
}

// Resumo por categoria somando TODA a janela (intervalo, não 1 dia isolado)
// — aqui a comparação "ano anterior" usa a mesma data crua (prevPorDiaCategoria
// já vem deslocada por mesmoDiaAnoAnterior em resolveSazonalidadeWindow/
// diarioResolveWindow), critério correto pra soma de intervalo (mesmo usado
// em Objetivos "datas exatas" — ver nota de metodologia no topo do arquivo).
// posAtual/posAnt (opcionais): { porCategoria } de diarioPositivacao(), pra
// anexar Positivação por categoria na mesma linha, sem nova consulta.
function diarioResumoCategorias(win, posAtual, posAnt){
  const cats = ST.cat.length ? ST.cat : diarioCategoriasNaJanela(win.porDiaCategoria);
  return cats.map(cat=>{
    let r=0, c=0;
    Object.values(win.porDiaCategoria||{}).forEach(m=>{ const v=m[cat]; if (v){ r+=v[0]||0; c+=v[1]||0; } });
    let rPrev=0, cPrev=0, temPrev=false;
    Object.values(win.prevPorDiaCategoria||{}).forEach(m=>{ const v=m[cat]; if (v){ rPrev+=v[0]||0; cPrev+=v[1]||0; temPrev=true; } });
    return { nome:cat, r, c, m: r>0?100*(1-c/r):0, rPrev: temPrev?rPrev:null, cPrev: temPrev?cPrev:null,
      nCli: posAtual ? (posAtual.porCategoria[cat]!=null?posAtual.porCategoria[cat]:null) : null,
      prevNCli: posAnt ? (posAnt.porCategoria[cat]!=null?posAnt.porCategoria[cat]:null) : null };
  }).filter(l=>l.r>0 || l.rPrev!=null).sort((a,b)=>b.r-a.r);
}

// Série contínua (todo dia corrido entre ini/fim, 0 nos dias sem venda) —
// mesmo critério de computeDowSeries/tendencia: dia sem registro conta como
// 0, nunca é tratado como "sem dado" (é o cubo dizendo que não houve venda).
function diarioSerieContinua(porDia, iniStr, finStr){
  const out = [];
  if (!iniStr || !finStr) return out;
  const start = new Date(iniStr+'T00:00:00'), end = new Date(finStr+'T00:00:00');
  for (let dt=new Date(start); dt<=end; dt.setDate(dt.getDate()+1)){
    const key = dt.toISOString().slice(0,10);
    const v = porDia[key];
    out.push({ data:key, r: v?(v[0]||0):0, c: v?(v[1]||0):0 });
  }
  return out;
}

function diarioMediaMovel(serie, janela){
  return serie.map((_,i)=>{
    const fatia = serie.slice(Math.max(0,i-janela+1), i+1);
    return fatia.reduce((s,x)=>s+x.r,0) / fatia.length;
  });
}

// Média de receita de um dia-da-semana específico (0-6) dentro de [ini,fim],
// excluindo `excluirData` (o próprio dia avaliado, pra não comparar um valor
// com uma média que o inclui) — contextualiza se o último dia fechado foi
// um dia típico ou atípico para aquele dia da semana, dentro da MESMA janela.
function diarioMediaMesmoDiaSemana(porDia, iniStr, finStr, dowAlvo, excluirData){
  if (!iniStr || !finStr) return null;
  const start = new Date(iniStr+'T00:00:00'), end = new Date(finStr+'T00:00:00');
  let soma=0, n=0;
  for (let dt=new Date(start); dt<=end; dt.setDate(dt.getDate()+1)){
    if (dt.getDay()!==dowAlvo) continue;
    const key = dt.toISOString().slice(0,10);
    if (key===excluirData) continue;
    const v = porDia[key];
    soma += v?(v[0]||0):0; n++;
  }
  return n>0 ? soma/n : null;
}

function diarioKpiHTML(k, i){
  return `<div class="kpi k${i%7}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-val">${k.val}</div>
    ${k.cur!=null?deltaPillSmall(k.cur,k.prevv):''}
    <div class="kpi-note">${k.note||''}</div></div>`;
}

// Delta vs. ano anterior de 1 dia isolado, alinhado por dia da semana — usado
// tanto no hero quanto na tabela, pra garantir a MESMA regra nos dois lugares.
function diarioDeltaAnoAnt(dt, porDia, prevPorDia){
  const dtAnt = diarioMesmoDiaSemanaAnoAnt(dt);
  const vAnt = prevPorDia[dtAnt];
  return { dtAnt, vAnt, rAnt: vAnt?(vAnt[0]||0):null, cAnt: vAnt?(vAnt[1]||0):null };
}

// Matriz Venda por Dia × Categoria (crua, sem passar pelo filtro de Mix de
// categorias já colapsado em `porDia`) — colunas na mesma ordem do resumo
// por categoria (já ordenado por receita desc / já respeita ST.cat).
function diarioMatrizDiaCategoriaHTML(win, nomesCats, hojeStr, limite){
  if (!nomesCats.length) return '';
  const dias = Object.keys(win.porDiaCategoria||{}).filter(dt=>dt>=win.iniStr && dt<=win.finStr).sort().reverse().slice(0, limite);
  if (!dias.length) return '';
  const head = `<thead><tr><th>Data</th><th>Dia da Semana</th>${nomesCats.map(c=>`<th class="tv">${c}</th>`).join('')}<th class="tv">Total</th></tr></thead>`;
  const body = dias.map(dt=>{
    const catMap = win.porDiaCategoria[dt] || {};
    let total = 0;
    const cells = nomesCats.map(cat=>{ const v=catMap[cat]; const r=v?(v[0]||0):0; total+=r; return `<td class="tv">${r>0?fF(r):'<span style="color:var(--t3)">—</span>'}</td>`; }).join('');
    const ehHoje = dt===hojeStr;
    return `<tr><td class="tn">${diarioFmtData(dt)}${ehHoje?' <span class="kpi-note" style="display:inline">(hoje)</span>':''}</td><td>${diarioNomeDow(dt)}</td>${cells}<td class="tv" style="font-weight:700">${fF(total)}</td></tr>`;
  }).join('');
  return head + `<tbody>${body}</tbody>`;
}

function renderDiario(){
  const sel = document.getElementById('fDiarioBase');
  if (sel) sel.value = DIARIO.base;
  populateDiarioSubFiltro();

  const level = hierLevelActive();
  const names = level==='gerente' ? hierSelectedNames('gerente') : null;
  const hierNoteEl = document.getElementById('diarioHierNote');
  if (hierNoteEl) hierNoteEl.innerHTML = (typeof diaFilterNote === 'function') ? diaFilterNote(!!(names && names.length)) : '';
  const catNoteEl = document.getElementById('diarioCatNote');
  if (catNoteEl) catNoteEl.innerHTML = ST.cat.length ? `<div class="alert">Recortado por <strong>Categoria: ${labelJoin(ST.cat)}</strong> — o resumo por categoria e a matriz abaixo mostram só as categorias selecionadas.</div>` : '';

  const win = diarioResolveWindow(DIARIO.base, names);
  const subEl = document.getElementById('diarioSub');
  const temDados = Object.keys(win.porDia||{}).length>0;
  if (!temDados){
    if (subEl) subEl.textContent = DIARIO.base==='custom' ? win.label : `${win.label} — sem dados diários disponíveis.`;
    ['diario-kpis-hoje','diario-melhor-dia','diario-pior-dia','diario-cat-table','diario-positivacao'].forEach(id=>{ const el=document.getElementById(id); if (el) el.innerHTML=''; });
    const tEl = document.getElementById('tDiario'); if (tEl) tEl.innerHTML = '';
    const tCatDiaEl = document.getElementById('tDiarioCatDia'); if (tCatDiaEl) tCatDiaEl.innerHTML = '';
    const tPosCatDiaElVazio = document.getElementById('tDiarioPosCatDia'); if (tPosCatDiaElVazio) tPosCatDiaElVazio.innerHTML = '';
    if (charts['cDiario']) { charts['cDiario'].destroy(); delete charts['cDiario']; }
    if (charts['cDiarioCat']) { charts['cDiarioCat'].destroy(); delete charts['cDiarioCat']; }
    return null;
  }

  const cats = ST.cat.length ? ST.cat : null;
  const porDia = diarioFiltrarCategorias(win.porDia, win.porDiaCategoria, cats);
  const prevPorDia = diarioFiltrarCategorias(win.prevPorDia, win.prevPorDiaCategoria, cats);
  const temPrev = Object.keys(prevPorDia).length>0;

  if (subEl) subEl.textContent = win.label + (temPrev ? ` · comparado ao mesmo dia da semana, na mesma época de ${fmtBR(win.prevIniStr)} a ${fmtBR(win.prevFinStr)} do ano anterior` : ' · sem base do ano anterior para comparar');

  const diasComDado = Object.keys(porDia).filter(dt=>dt>=win.iniStr && dt<=win.finStr).sort();
  const hojeStr = diarioIsoLocal(new Date());
  // "Hoje" (quando aparece na janela) é sempre tratado como EM ANDAMENTO —
  // nunca entra no "último dia fechado", no melhor/pior dia nem ganha Δ vs.
  // ano anterior (ver nota de metodologia no topo do arquivo).
  const diasFechados = diasComDado.filter(dt=>dt!==hojeStr);
  const hojeParcial = diasComDado.includes(hojeStr) ? porDia[hojeStr] : null;

  // ── 1) Último dia FECHADO com venda + (se houver) nota de hoje em andamento ──
  const heroEl = document.getElementById('diario-kpis-hoje');
  if (heroEl){
    if (!diasFechados.length){
      heroEl.innerHTML = hojeParcial
        ? '<div class="alert" style="grid-column:1/-1">⚠ Só há dado de hoje (em andamento) nesta janela/recorte — ainda sem dia fechado para comparar.</div>'
        : '<div class="alert" style="grid-column:1/-1">⚠ Nenhum dia com venda registrada nesta janela/recorte.</div>';
    } else {
      const ultimaData = diasFechados[diasFechados.length-1];
      const v = porDia[ultimaData];
      const r = v[0]||0, c = v[1]||0, m = r>0?100*(1-c/r):0;
      const { dtAnt, vAnt, rAnt, cAnt } = diarioDeltaAnoAnt(ultimaData, porDia, prevPorDia);
      const mAnt = (vAnt && rAnt>0) ? 100*(1-cAnt/rAnt) : null;
      const noteVs = vAnt ? `vs. ${diarioFmtData(dtAnt)} (mesmo dia da semana, ano anterior)` : 'sem mesmo dia da semana equivalente no ano anterior';
      const kpis = [
        { lbl:'Último dia fechado', val:`${diarioFmtData(ultimaData)} (${diarioNomeDow(ultimaData)})`, note:'' },
        { lbl:'Receita do dia', val:fF(r), cur:r, prevv:rAnt, note:noteVs },
        { lbl:'Cash Margem do dia', val:fF(r-c), cur:r-c, prevv:(rAnt!=null&&cAnt!=null)?(rAnt-cAnt):null, note:noteVs },
        { lbl:'Margem % do dia', val:r>0?fPct(m):'—', cur:m, prevv:mAnt, note:noteVs },
      ];
      // Positivação do dia (clientes distintos) — só quando o cubo não está
      // bloqueado por filtro de hierarquia/cliente/canal/status/grupo (mesma
      // trava da Positivação Geral, ver diarioPositivacaoBloqueios).
      if (!diarioPositivacaoBloqueios().length){
        const posDia = diarioPositivacaoDia(ultimaData);
        if (posDia!=null) kpis.push({ lbl:'Positivação do dia', val:fN(posDia), note:'clientes distintos atendidos nesse dia' });
      }
      // Contexto extra: esse dia foi típico ou atípico dentro da própria janela,
      // comparado à média do MESMO dia da semana (não o ano anterior).
      const mediaDow = diarioMediaMesmoDiaSemana(porDia, win.iniStr, win.finStr, new Date(ultimaData+'T00:00:00').getDay(), ultimaData);
      if (mediaDow!=null){
        kpis.push({ lbl:`Média de ${diarioNomeDow(ultimaData)}s na janela`, val:fF(mediaDow), cur:r, prevv:mediaDow, note:'receita do dia acima vs. a média do mesmo dia da semana nesta janela' });
      }
      if (hojeParcial){
        const rH = hojeParcial[0]||0, cH = hojeParcial[1]||0, mH = rH>0?100*(1-cH/rH):0;
        kpis.push({ lbl:'Hoje (em andamento)', val:fF(rH), note:`Margem ${rH>0?fPct(mH):'—'} · dia ainda não fechado, sem comparação` });
      }
      heroEl.innerHTML = kpis.map(diarioKpiHTML).join('');
    }
  }

  // ── 2) Melhor/pior dia do período — só entre dias FECHADOS com venda > 0
  // (hoje em andamento nunca entra; um dia de loja fechada/sem pedido também
  // não deve virar "pior dia", é um não-evento) ──
  const diasComVenda = diasFechados.filter(dt=>(porDia[dt][0]||0) > 0);
  const cardDia = (dt)=>{
    const v = porDia[dt]; const r=v[0]||0, c=v[1]||0, m=r>0?100*(1-c/r):0;
    return `<div class="kpi" style="margin:0"><div class="kpi-lbl">${diarioFmtData(dt)} — ${diarioNomeDow(dt)}</div><div class="kpi-val">${fF(r)}</div><div class="kpi-note">Cash Margem ${fF(r-c)} · Margem ${fPct(m)}</div></div>`;
  };
  const melhorEl = document.getElementById('diario-melhor-dia'), piorEl = document.getElementById('diario-pior-dia');
  if (melhorEl) melhorEl.innerHTML = diasComVenda.length ? cardDia(diasComVenda.slice().sort((a,b)=>porDia[b][0]-porDia[a][0])[0]) : '<div class="alert">Sem dias fechados com venda nesta janela.</div>';
  if (piorEl) piorEl.innerHTML = diasComVenda.length ? cardDia(diasComVenda.slice().sort((a,b)=>porDia[a][0]-porDia[b][0])[0]) : '<div class="alert">Sem dias fechados com venda nesta janela.</div>';

  // ── 3) Positivação Geral — dia a dia, exata à janela exibida (ver nota 3 de
  // metodologia). Bloqueada (nunca aproximada em silêncio) se houver filtro
  // que o cubo não suporta nesta leitura. ──
  const bloqueios = diarioPositivacaoBloqueios();
  const posEl = document.getElementById('diario-positivacao');
  let posAtual = null, posAnt = null;
  if (posEl){
    if (bloqueios.length){
      posEl.innerHTML = `<div class="alert" style="grid-column:1/-1">⚠ Positivação indisponível com filtro de <strong>${bloqueios.join(', ')}</strong> ativo — o cubo de códigos de cliente não tem recorte pronto para esse(s) filtro(s) (só existe nível empresa). Limpe o(s) filtro(s) acima para ver a positivação desta janela.</div>`;
    } else {
      posAtual = diarioPositivacao(win.iniStr, win.finStr);
      posAnt = diarioPositivacao(win.prevIniStr, win.prevFinStr);
      if (posAtual.totalGeral==null){
        posEl.innerHTML = '<div class="alert" style="grid-column:1/-1">⚠ Sem dado de positivação para esta janela (cache antigo ou período ainda não processado pelo ETL).</div>';
      } else {
        posEl.innerHTML = [{
          lbl:'Positivação Geral (clientes distintos)', val:fN(posAtual.totalGeral), cur:posAtual.totalGeral, prevv:posAnt.totalGeral,
          note: posAtual.grao==='mes'
            ? `Meses considerados: ${posAtual.mesesUsados.join(', ')} — grão de mês civil (cache ainda não reprocessado com o grão diário), pode incluir dias fora do intervalo exibido`
            : `Exata ao intervalo exibido (${win.iniStr?diarioFmtData(win.iniStr):'—'} a ${win.finStr?diarioFmtData(win.finStr):'—'}).`,
        }].map(diarioKpiHTML).join('');
      }
    }
  }

  // ── 4) Resumo por Categoria na janela inteira (soma do intervalo, não
  // 1 dia) — tabela + mix em doughnut — agora com Positivação por categoria ──
  const resumoCats = diarioResumoCategorias(win, posAtual, posAnt);
  const catTableEl = document.getElementById('diario-cat-table');
  if (catTableEl){
    if (!resumoCats.length){
      catTableEl.innerHTML = '<div class="alert">Sem dado por categoria nesta janela/recorte.</div>';
    } else {
      const totalR = resumoCats.reduce((s,l)=>s+l.r,0), totalC = resumoCats.reduce((s,l)=>s+l.c,0);
      const totalPrevR = resumoCats.every(l=>l.rPrev!=null) ? resumoCats.reduce((s,l)=>s+l.rPrev,0) : null;
      const temPos = !!posAtual;
      catTableEl.innerHTML = `<thead><tr><th>Categoria</th><th class="tv">Receita</th><th class="tv">% do Total</th><th class="tv">Cash Margem</th><th class="tv">Margem %</th><th class="tv">Δ vs Ano Ant.</th>${temPos?'<th class="tv">Positivação</th><th class="tv">Δ Positivação</th>':''}</tr></thead><tbody>${
        resumoCats.map(l=>`<tr><td class="tn">${l.nome}</td><td class="tv">${fF(l.r)}</td><td class="tv">${totalR>0?(l.r/totalR*100).toFixed(1)+'%':'—'}</td><td class="tv">${fF(l.r-l.c)}</td><td class="tv">${l.r>0?fPct(l.m):'—'}</td><td class="tv">${deltaPillSmall(l.r,l.rPrev)}</td>${temPos?`<td class="tv">${l.nCli!=null?fN(l.nCli):'<span style="color:var(--t3)">—</span>'}</td><td class="tv">${l.nCli!=null?deltaPillSmall(l.nCli,l.prevNCli):'<span style="color:var(--t3)">—</span>'}</td>`:''}</tr>`).join('')
      }<tr style="font-weight:700"><td class="tn">TOTAL GERAL</td><td class="tv">${fF(totalR)}</td><td class="tv">100,0%</td><td class="tv">${fF(totalR-totalC)}</td><td class="tv">${totalR>0?fPct(100*(1-totalC/totalR)):'—'}</td><td class="tv">${deltaPillSmall(totalR,totalPrevR)}</td>${temPos?`<td class="tv">${posAtual.totalGeral!=null?fN(posAtual.totalGeral):'—'}</td><td class="tv">${posAtual.totalGeral!=null?deltaPillSmall(posAtual.totalGeral,posAnt.totalGeral):'—'}</td>`:''}</tr></tbody>`;
    }
    if (resumoCats.length){
      mkChart('cDiarioCat', { type:'doughnut', data:{ labels: resumoCats.map(l=>l.nome), datasets:[{ data: resumoCats.map(l=>l.r), backgroundColor: resumoCats.map((_,i)=>P[i%P.length]) }] },
        options:{ responsive:true, plugins:{ legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}, tooltip:{callbacks:{label:c=>' '+c.label+': '+fF(c.raw)}} } } });
    } else if (charts['cDiarioCat']) { charts['cDiarioCat'].destroy(); delete charts['cDiarioCat']; }
  }

  // ── 5) Venda por Dia × Categoria (matriz, dias mais recentes primeiro) ──
  const LIMITE_MATRIZ = 20;
  const nomesCats = resumoCats.map(l=>l.nome);
  const tCatDiaEl = document.getElementById('tDiarioCatDia'), tCatDiaSubEl = document.getElementById('diarioCatDiaSub');
  const totalDiasCat = Object.keys(win.porDiaCategoria||{}).filter(dt=>dt>=win.iniStr && dt<=win.finStr).length;
  if (tCatDiaSubEl) tCatDiaSubEl.textContent = totalDiasCat>LIMITE_MATRIZ ? `Mostrando os ${LIMITE_MATRIZ} dias mais recentes de ${totalDiasCat} no período.` : `${totalDiasCat} dia(s) no período.`;
  if (tCatDiaEl) tCatDiaEl.innerHTML = diarioMatrizDiaCategoriaHTML(win, nomesCats, hojeStr, LIMITE_MATRIZ);

  // ── 5b) Clientes Atendidos (Positivação) por Dia × Categoria — mesma
  // janela/categorias da matriz de receita acima, mas em clientes distintos
  // por dia (ver diarioMatrizPosDiaCategoriaHTML) — bloqueada pelo mesmo
  // filtro que bloqueia a Positivação Geral (seção 3).
  const tPosCatDiaEl = document.getElementById('tDiarioPosCatDia'), tPosCatDiaSubEl = document.getElementById('diarioPosCatDiaSub');
  if (tPosCatDiaEl){
    if (bloqueios.length){
      tPosCatDiaEl.innerHTML = '';
      if (tPosCatDiaSubEl) tPosCatDiaSubEl.textContent = `Indisponível com filtro de ${bloqueios.join(', ')} ativo.`;
    } else {
      const matrizPos = diarioMatrizPosDiaCategoriaHTML(win.iniStr, win.finStr, nomesCats, hojeStr, LIMITE_MATRIZ);
      tPosCatDiaEl.innerHTML = matrizPos;
      if (tPosCatDiaSubEl) tPosCatDiaSubEl.textContent = matrizPos ? `Mostrando os dias mais recentes com dado de positivação no período (até ${LIMITE_MATRIZ}).` : 'Sem dado de positivação por dia nesta janela (cache antigo ou período ainda não processado pelo ETL).';
    }
  }

  // ── 6) Gráfico: Receita por dia (série contínua) + média móvel de 7 dias ──
  const serie = diarioSerieContinua(porDia, win.iniStr, win.finStr);
  const mm7 = diarioMediaMovel(serie, 7);
  mkChart('cDiario', { type:'line', data:{ labels: serie.map(p=>diarioFmtData(p.data)), datasets:[
    { label:'Receita do dia', data: serie.map(p=>p.r), borderColor:C.acc+'88', backgroundColor:'transparent', borderWidth:1, pointRadius:0, tension:.15 },
    { label:'Média móvel (7 dias)', data: mm7, borderColor:C.acc3, backgroundColor:'transparent', borderWidth:2.5, pointRadius:0, tension:.25 },
  ]}, options:{ responsive:true, plugins:{ legend:{position:'top',labels:{boxWidth:10,font:{size:10}}}, tooltip:{callbacks:{label:c=>' '+c.dataset.label+': '+fF(c.raw)}} },
    scales:{ x:{ ticks:{ maxTicksLimit:12 } }, y:{ ticks:{ callback:v=>fM(v) } } } } });

  // ── 7) Tabela dos dias mais recentes (mais novo primeiro; hoje em
  // andamento aparece com o valor real, mas sem Δ — ver nota de metodologia) ──
  const LIMITE = 45;
  const recentes = diasComDado.slice().reverse().slice(0, LIMITE);
  const tEl = document.getElementById('tDiario'), tSubEl = document.getElementById('diarioTabelaSub');
  if (tSubEl) tSubEl.textContent = diasComDado.length>LIMITE ? `Mostrando os ${LIMITE} dias mais recentes de ${diasComDado.length} no período.` : `${diasComDado.length} dia(s) com venda no período.`;
  const temPosDia = !bloqueios.length;
  if (tEl) tEl.innerHTML = `<thead><tr><th>Data</th><th>Dia da Semana</th><th class="tv">Receita</th><th class="tv">Cash Margem</th><th class="tv">Margem %</th><th class="tv">Δ vs Ano Ant.</th>${temPosDia?'<th class="tv">Positivação</th>':''}</tr></thead><tbody>${
    recentes.map(dt=>{
      const v = porDia[dt]; const r=v[0]||0, c=v[1]||0, m=r>0?100*(1-c/r):0;
      const ehHoje = dt===hojeStr;
      const deltaCell = ehHoje ? '<span style="color:var(--t3)">em andamento</span>' : deltaPillSmall(r, diarioDeltaAnoAnt(dt, porDia, prevPorDia).rAnt);
      const posCell = temPosDia ? (()=>{ const p = diarioPositivacaoDia(dt); return `<td class="tv">${p!=null?fN(p):'<span style="color:var(--t3)">—</span>'}</td>`; })() : '';
      return `<tr><td class="tn">${diarioFmtData(dt)}${ehHoje?' <span class="kpi-note" style="display:inline">(hoje)</span>':''}</td><td>${diarioNomeDow(dt)}</td><td class="tv">${fF(r)}</td><td class="tv">${fF(r-c)}</td><td class="tv">${r>0?fPct(m):'—'}</td><td class="tv">${deltaCell}</td>${posCell}</tr>`;
    }).join('')
  }</tbody>`;

  // ── Exposição aditiva (consumida pela Apresentação Executiva) — não lida
  // por nenhum código desta aba, só leitura dos valores já calculados acima.
  const ultimaData = diasFechados.length ? diasFechados[diasFechados.length-1] : null;
  let ultimoDiaFechado = null;
  if (ultimaData){
    const v = porDia[ultimaData]; const r=v[0]||0, c=v[1]||0, m=r>0?100*(1-c/r):0;
    const { rAnt } = diarioDeltaAnoAnt(ultimaData, porDia, prevPorDia);
    const posUltimaData = bloqueios.length ? null : diarioPositivacaoDia(ultimaData);
    ultimoDiaFechado = { data:ultimaData, receita:r, cashMargem:r-c, margemPct:r>0?m:null, deltaAnoAnt:rAnt, positivacao:posUltimaData };
  }
  const diaResumo = (dt)=>{
    if (!dt) return null;
    const v = porDia[dt]; const r=v[0]||0, c=v[1]||0;
    return { data:dt, receita:r, cashMargem:r-c, margemPct:r>0?100*(1-c/r):null };
  };
  const melhorDiaKey = diasComVenda.length ? diasComVenda.slice().sort((a,b)=>porDia[b][0]-porDia[a][0])[0] : null;
  const piorDiaKey = diasComVenda.length ? diasComVenda.slice().sort((a,b)=>porDia[a][0]-porDia[b][0])[0] : null;

  return {
    label: win.label,
    ultimoDiaFechado,
    hojeParcial: hojeParcial ? { receita: hojeParcial[0]||0 } : null,
    melhorDia: diaResumo(melhorDiaKey),
    piorDia: diaResumo(piorDiaKey),
    positivacaoGeral: posAtual ? { total: posAtual.totalGeral, prevTotal: posAnt?posAnt.totalGeral:null, mesesUsados: posAtual.mesesUsados } : null,
    resumoCats,
    serieDiaria: serie,
  };
}

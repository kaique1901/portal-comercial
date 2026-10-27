// ── VENDAS POR HORÁRIO ───────────────────────────────────────────────────
// Lê por_hora/por_hora_categoria do período (curPeriod(), que já troca o cubo
// pelo /recorte quando há filtro ativo — então Gerente/Supervisor/Vendedor/
// Categoria/Cliente/Canal/Status e a trava do usuário logado valem aqui igual
// às outras abas). Só leitura: não escreve em DOM/variável de outra aba.
//
// Formas (ver buildPorHora em DashboardETLService.js):
//   por_hora[anomes][dow][hora]            = [receita, custo, pedidos]
//   por_hora_categoria[anomes][hora][cat]  = [receita, custo]
// dow = ISODOW (1=Segunda ... 7=Domingo). hora 0-23 ou 'nd' (pedido sem hora).
//
// Hora = momento em que o pedido foi DIGITADO (app de força de vendas ou
// balcão), não o faturamento/fechamento — DataFechamento no ERP só tem a data.
// Pedidos sem hora registrada aparecem à parte ("Sem hora"), nunca são
// redistribuídos entre as faixas.
//
// Nº de pedidos só existe no total por hora/dia da semana (somável: cada
// pedido cai numa única célula). Por categoria não há contagem de pedidos —
// um pedido com 2 categorias seria contado 2x — então ali só receita/margem.

let HORARIO = { metricaMapa: 'r', abertos: new Set(), _ctx: null };
function onHorarioMetricaChange(v){ HORARIO.metricaMapa = v; renderHorario(); }
// Abrir/fechar só redesenha a tabela — gráfico e mapa não mudam.
function toggleHorarioCascata(key){
  if (HORARIO.abertos.has(key)) HORARIO.abertos.delete(key); else HORARIO.abertos.add(key);
  horarioTabelaCascata();
}
function horarioExpandirTudo(abrir){
  HORARIO.abertos.clear();
  const ctx = HORARIO._ctx;
  if (abrir && ctx) ctx.linhas.forEach(l=>HORARIO.abertos.add('H|'+l.h));
  horarioTabelaCascata();
}

// Lista de produtos da cascata (Top N por hora+categoria, ver buildHoraProduto):
//  • recorte (/recorte): `total` já é exatamente a seleção de meses/filtros;
//  • cubo com 1 mês selecionado: por_mes[anomes] (Top N daquele mês);
//  • cubo sem mês: `total` = período inteiro.
// Nunca soma o Top N de meses diferentes (não daria o Top N do conjunto).
// null = cache antigo sem o campo → a tabela avisa e abre só até Categoria.
function horarioFonteProduto(p){
  const php = p.por_hora_produto;
  if (!php || !php.total) return null;
  if (!p._recorte && ST.meses.length === 1) return { porHora: (php.por_mes || {})[ST.meses[0]] || {}, topN: php.top_n };
  return { porHora: php.total, topN: php.top_n };
}

const HORARIO_DOW = {1:'Segunda',2:'Terça',3:'Quarta',4:'Quinta',5:'Sexta',6:'Sábado',7:'Domingo'};
const horarioFaixa = h => `${String(h).padStart(2,'0')}h–${String(h+1).padStart(2,'0')}h`;
const horarioMargem = (r, c) => r>0 ? 100*(1-c/r) : null;

// Meses (YYYY-MM) do cubo/recorte que entram na tela: os do filtro de Mês, ou
// todos do período quando nenhum mês está selecionado.
function horarioMesesNaJanela(porHora){
  const disp = Object.keys(porHora || {}).sort();
  if (!ST.meses.length) return disp;
  const sel = new Set(ST.meses);
  return disp.filter(am => sel.has(am));
}

// Soma as células dos meses escolhidos. Devolve totais por hora, por
// (dow,hora), por (hora,categoria) e o bloco "sem hora".
function horarioAgregar(p, meses){
  const porHora = {}, porDowHora = {}, porHoraCat = {}, porCat = {};
  const semHora = [0,0,0];
  const tot = [0,0,0];
  meses.forEach(am=>{
    const m = (p.por_hora || {})[am] || {};
    Object.keys(m).forEach(dw=>{
      Object.entries(m[dw]).forEach(([h, v])=>{
        tot[0]+=v[0]||0; tot[1]+=v[1]||0; tot[2]+=v[2]||0;
        if (h==='nd'){ semHora[0]+=v[0]||0; semHora[1]+=v[1]||0; semHora[2]+=v[2]||0; return; }
        const a = porHora[h] || (porHora[h] = [0,0,0]);
        a[0]+=v[0]||0; a[1]+=v[1]||0; a[2]+=v[2]||0;
        const d = porDowHora[dw] || (porDowHora[dw] = {});
        const b = d[h] || (d[h] = [0,0,0]);
        b[0]+=v[0]||0; b[1]+=v[1]||0; b[2]+=v[2]||0;
      });
    });
    const mc = (p.por_hora_categoria || {})[am] || {};
    Object.entries(mc).forEach(([h, cats])=>{
      Object.entries(cats).forEach(([cat, v])=>{
        const t = porCat[cat] || (porCat[cat] = [0,0]); t[0]+=v[0]||0; t[1]+=v[1]||0;
        if (h==='nd') return;
        const hc = porHoraCat[h] || (porHoraCat[h] = {});
        const a = hc[cat] || (hc[cat] = [0,0]); a[0]+=v[0]||0; a[1]+=v[1]||0;
      });
    });
  });
  const horas = Object.keys(porHora).map(Number).sort((a,b)=>a-b);
  // Faixa contínua entre a primeira e a última hora com venda — hora sem venda
  // no meio aparece como 0 (é o dado dizendo que não houve pedido).
  const faixa = [];
  if (horas.length) for (let h=horas[0]; h<=horas[horas.length-1]; h++) faixa.push(h);
  return { porHora, porDowHora, porHoraCat, porCat, semHora, tot, faixa };
}

function horarioTabelaCascata(){
  const tEl = document.getElementById('tHorario');
  const ctx = HORARIO._ctx;
  if (!tEl || !ctx) return;
  const { A, linhas, comHoraR, prod } = ctx;
  const vazio = '<span style="color:var(--t3)">—</span>';
  const pct = (v, base) => base>0 ? (v/base*100).toFixed(1)+'%' : vazio;
  const mg = (r, c) => { const m = horarioMargem(r, c); return m!=null ? fPct(m) : vazio; };
  const tog = (key, aberto) => `<span class="casc-toggle" onclick="toggleHorarioCascata('${escAttr(key).replace(/'/g,"\\'")}')">${aberto?'−':'+'}</span>`;
  let acum = 0, html = '';
  linhas.forEach(l=>{
    acum += l.r;
    const kH = 'H|'+l.h, abertoH = HORARIO.abertos.has(kH);
    html += `<tr class="casc-lvl0"><td class="tn">${tog(kH, abertoH)}${horarioFaixa(l.h)}</td><td class="tv">${fF(l.r)}</td><td class="tv">${pct(l.r, comHoraR)}</td><td class="tv">${pct(acum, comHoraR)}</td><td class="tv">${fF(l.r-l.c)}</td><td class="tv">${mg(l.r, l.c)}</td><td class="tv">${fN(l.ped)}</td><td class="tv">${l.ped>0?fF(l.r/l.ped):vazio}</td></tr>`;
    if (!abertoH) return;
    const cats = Object.entries(A.porHoraCat[l.h] || {}).filter(([,v])=>(v[0]||0)!==0).sort((a,b)=>b[1][0]-a[1][0]);
    if (!cats.length){ html += `<tr class="casc-lvl1"><td colspan="8" style="padding-left:24px;color:var(--t3)">Sem receita por categoria nesta faixa.</td></tr>`; return; }
    cats.forEach(([cat, v])=>{
      const kC = kH+'|'+cat, abertoC = HORARIO.abertos.has(kC);
      const podeAbrir = !!prod;
      html += `<tr class="casc-lvl1"><td style="padding-left:24px">${podeAbrir?tog(kC, abertoC):''}${escAttr(cat)}</td><td class="tv">${fF(v[0])}</td><td class="tv" title="% da receita desta faixa">${pct(v[0], l.r)}</td><td class="tv"></td><td class="tv">${fF(v[0]-v[1])}</td><td class="tv">${mg(v[0], v[1])}</td><td class="tv"></td><td class="tv"></td></tr>`;
      if (!podeAbrir || !abertoC) return;
      const itens = ((prod.porHora[l.h] || {})[cat]) || [];
      let sr = 0, sc = 0;
      itens.forEach((it, i)=>{
        sr += it.r; sc += it.c;
        html += `<tr class="casc-lvl2"><td style="padding-left:48px;font-style:italic">${i+1}. ${escAttr(it.nome)}</td><td class="tv">${fF(it.r)}</td><td class="tv" title="% da receita da categoria nesta faixa">${pct(it.r, v[0])}</td><td class="tv"></td><td class="tv">${fF(it.r-it.c)}</td><td class="tv">${mg(it.r, it.c)}</td><td class="tv" colspan="2" style="color:var(--t3)">Qtde ${fN(it.q)}</td></tr>`;
      });
      // Demais = total EXATO da categoria na faixa − soma do Top N exibido.
      const dr = v[0] - sr, dc = v[1] - sc;
      if (Math.abs(dr) >= 0.5){
        html += `<tr class="casc-lvl3"><td style="padding-left:48px">Demais produtos (fora do Top ${prod.topN||itens.length})</td><td class="tv">${fF(dr)}</td><td class="tv">${pct(dr, v[0])}</td><td class="tv"></td><td class="tv">${fF(dr-dc)}</td><td class="tv">${mg(dr, dc)}</td><td class="tv"></td><td class="tv"></td></tr>`;
      }
    });
  });
  const sh = A.semHora;
  if (sh[2]>0 || sh[0]!==0){
    html += `<tr style="color:var(--t2)"><td class="tn">Sem hora</td><td class="tv">${fF(sh[0])}</td><td class="tv">${vazio}</td><td class="tv">${vazio}</td><td class="tv">${fF(sh[0]-sh[1])}</td><td class="tv">${mg(sh[0], sh[1])}</td><td class="tv">${fN(sh[2])}</td><td class="tv">${sh[2]>0?fF(sh[0]/sh[2]):vazio}</td></tr>`;
  }
  html += `<tr style="font-weight:700"><td class="tn">TOTAL</td><td class="tv">${fF(A.tot[0])}</td><td class="tv"></td><td class="tv"></td><td class="tv">${fF(A.tot[0]-A.tot[1])}</td><td class="tv">${mg(A.tot[0], A.tot[1])}</td><td class="tv">${fN(A.tot[2])}</td><td class="tv">${A.tot[2]>0?fF(A.tot[0]/A.tot[2]):vazio}</td></tr>`;
  tEl.innerHTML = `<thead><tr><th>Hora / Categoria / Produto</th><th class="tv">Receita</th><th class="tv">% Receita</th><th class="tv">% Acumulado</th><th class="tv">Cash Margem</th><th class="tv">Margem %</th><th class="tv">Pedidos</th><th class="tv">Ticket Médio</th></tr></thead><tbody>${html}</tbody>`;
  const notaEl = document.getElementById('horarioCascNota');
  if (notaEl) notaEl.textContent = prod
    ? `Clique em + para abrir Hora → Categoria → Produto. % da categoria = sobre a receita da faixa; % do produto = sobre a categoria naquela faixa. Produtos: Top ${prod.topN||20} por faixa+categoria, o restante somado em "Demais produtos".`
    : 'Detalhe por produto ainda não disponível para este período — por enquanto abre só até Categoria; aparece na próxima atualização dos dados.';
}

function horarioLimpar(msg){
  const alertEl = document.getElementById('horarioStatus');
  if (alertEl) alertEl.innerHTML = msg ? `<div class="alert"><span>⚠ ${msg}</span></div>` : '';
  HORARIO._ctx = null;
  ['horario-kpis','tHorario','tHorarioMapa','tHorarioCat'].forEach(id=>{ const el=document.getElementById(id); if (el) el.innerHTML=''; });
  if (charts['cHorario']) { charts['cHorario'].destroy(); delete charts['cHorario']; }
}

function renderHorario(){
  const sel = document.getElementById('fHorarioMetrica');
  if (sel) sel.value = HORARIO.metricaMapa;
  const p = curPeriod();
  const subEl = document.getElementById('horarioSub');
  if (!p){ horarioLimpar('Dados do período ainda não carregados.'); return null; }
  const rotulo = `${p.label || ST.per}${ST.meses.length ? ' · ' + rotuloMeses() : ''}`;
  if (subEl) subEl.textContent = rotulo;

  if (p._carregando){ horarioLimpar('Recorte do seu escopo ainda carregando…'); return null; }
  if (!p.por_hora){
    horarioLimpar('Dado de horário ainda não disponível para este período/recorte — aparece na próxima atualização dos dados.');
    return null;
  }
  const meses = horarioMesesNaJanela(p.por_hora);
  if (!meses.length){ horarioLimpar('Sem vendas com dado de horário nos meses selecionados.'); return null; }
  const A = horarioAgregar(p, meses);
  if (!A.faixa.length){ horarioLimpar('Nenhum pedido com hora registrada nos meses selecionados.'); return null; }

  const totR = A.tot[0], totPed = A.tot[2];
  const comHoraR = totR - A.semHora[0], comHoraPed = totPed - A.semHora[2];
  const statusEl = document.getElementById('horarioStatus');
  if (statusEl){
    const pctPed = totPed>0 ? comHoraPed/totPed*100 : 0;
    const pctR = totR>0 ? comHoraR/totR*100 : 0;
    statusEl.innerHTML = `<div class="alert"><span>Cobertura: <strong>${pctPed.toFixed(1)}%</strong> dos pedidos (${pctR.toFixed(1)}% da receita) têm hora registrada${A.semHora[2]>0?` — ${fN(A.semHora[2])} pedido(s) / ${fF(A.semHora[0])} sem hora ficam na linha <strong>Sem hora</strong> da tabela e fora do gráfico e do mapa`:''}. Percentuais por faixa são sobre a receita <strong>com</strong> hora.</span></div>`;
  }

  // ── 1) KPIs ──
  const linhas = A.faixa.map(h=>{ const v = A.porHora[h] || [0,0,0]; return { h, r:v[0], c:v[1], ped:v[2] }; });
  const picoR = linhas.slice().sort((a,b)=>b.r-a.r)[0];
  const picoP = linhas.slice().sort((a,b)=>b.ped-a.ped)[0];
  const somaFaixa = (ini, fim) => linhas.filter(l=>l.h>=ini && l.h<fim).reduce((s,l)=>s+l.r,0);
  const manha = somaFaixa(0,12), tarde = somaFaixa(12,18), noite = somaFaixa(18,24);
  const pctDe = v => comHoraR>0 ? (v/comHoraR*100).toFixed(1)+'%' : '—';
  const kpis = [
    { lbl:'Pico de receita', val:horarioFaixa(picoR.h), note:`${fF(picoR.r)} · ${pctDe(picoR.r)} da receita com hora` },
    { lbl:'Pico de pedidos', val:horarioFaixa(picoP.h), note:`${fN(picoP.ped)} pedidos · ticket médio ${picoP.ped>0?fF(picoP.r/picoP.ped):'—'}` },
    { lbl:'Manhã (até 12h)', val:pctDe(manha), note:`${fF(manha)} da receita` },
    { lbl:'Tarde (12h–18h)', val:pctDe(tarde), note:`${fF(tarde)} da receita` },
    { lbl:'Noite (18h em diante)', val:pctDe(noite), note:`${fF(noite)} da receita` },
  ];
  const kEl = document.getElementById('horario-kpis');
  if (kEl) kEl.innerHTML = kpis.map((k,i)=>`<div class="kpi k${i%7}"><div class="kpi-stripe"></div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-val">${k.val}</div><div class="kpi-note">${k.note}</div></div>`).join('');

  // ── 2) Gráfico: receita (barras) + pedidos (linha, eixo direito) ──
  mkChart('cHorario', { type:'bar', data:{ labels: linhas.map(l=>horarioFaixa(l.h)), datasets:[
    { type:'bar', label:'Receita', data: linhas.map(l=>l.r), backgroundColor: C.acc+'cc', yAxisID:'y', order:2 },
    { type:'line', label:'Pedidos', data: linhas.map(l=>l.ped), borderColor: C.acc3, backgroundColor:'transparent', borderWidth:2.5, pointRadius:2, tension:.25, yAxisID:'y2', order:1 },
  ]}, options:{ responsive:true, interaction:{mode:'index',intersect:false},
    plugins:{ legend:{position:'top',labels:{boxWidth:10,font:{size:10}}},
      tooltip:{callbacks:{label:c=>' '+c.dataset.label+': '+(c.dataset.yAxisID==='y'?fF(c.raw):fN(c.raw))}} },
    scales:{ y:{ position:'left', ticks:{ callback:v=>fM(v) } }, y2:{ position:'right', grid:{drawOnChartArea:false}, ticks:{ callback:v=>fN(v) } } } } });

  // ── 3) Tabela por faixa horária em cascata (Hora → Categoria → Produto) ──
  HORARIO._ctx = { A, linhas, comHoraR, prod: horarioFonteProduto(p) };
  horarioTabelaCascata();

  // ── 4) Mapa de calor Dia da Semana × Hora ──
  const met = HORARIO.metricaMapa;   // 'r' receita | 'ped' pedidos | 'm' margem %
  const valor = v => !v ? null : met==='r' ? v[0] : met==='ped' ? v[2] : horarioMargem(v[0], v[1]);
  const fmtVal = x => x==null ? '' : met==='r' ? fM(x) : met==='ped' ? fN(x) : fPct(x);
  const dows = Object.keys(A.porDowHora).map(Number).sort((a,b)=>a-b);
  const vals = [];
  dows.forEach(dw=>A.faixa.forEach(h=>{ const x = valor(A.porDowHora[dw][h]); if (x!=null) vals.push(x); }));
  const vMin = vals.length ? Math.min(...vals) : 0, vMax = vals.length ? Math.max(...vals) : 0;
  const mapaEl = document.getElementById('tHorarioMapa');
  if (mapaEl){
    const cel = x => {
      if (x==null) return `<td class="tv" style="color:var(--t3)">—</td>`;
      // Margem % usa a faixa min–max (pode ter valores parecidos); receita/pedidos partem do zero.
      const base = met==='m' ? vMin : 0;
      const t = vMax>base ? (x-base)/(vMax-base) : 0;
      const a = 0.08 + 0.82*t;
      return `<td class="tv" style="background:rgba(47,148,104,${a.toFixed(2)});${a>0.55?'color:#fff;':''}text-align:center" title="${fmtVal(x)}">${fmtVal(x)}</td>`;
    };
    mapaEl.innerHTML = `<thead><tr><th>Dia</th>${A.faixa.map(h=>`<th class="tv" style="text-align:center">${String(h).padStart(2,'0')}h</th>`).join('')}</tr></thead><tbody>${
      dows.map(dw=>`<tr><td class="tn">${HORARIO_DOW[dw]||dw}</td>${A.faixa.map(h=>cel(valor(A.porDowHora[dw][h]))).join('')}</tr>`).join('')
    }</tbody>`;
  }

  // ── 5) Receita por Hora × Categoria ──
  const cats = Object.keys(A.porCat).filter(c=>(A.porCat[c][0]||0)!==0).sort((a,b)=>A.porCat[b][0]-A.porCat[a][0]);
  const catEl = document.getElementById('tHorarioCat');
  if (catEl){
    if (!cats.length){
      catEl.innerHTML = '<tbody><tr><td>Sem receita por categoria nesta seleção.</td></tr></tbody>';
    } else {
      const totCat = {};
      const body = A.faixa.map(h=>{
        const hc = A.porHoraCat[h] || {};
        let tl = 0;
        const cells = cats.map(cat=>{ const r = hc[cat] ? hc[cat][0] : 0; tl += r; totCat[cat] = (totCat[cat]||0) + r;
          return `<td class="tv">${r!==0?fF(r):'<span style="color:var(--t3)">—</span>'}</td>`; }).join('');
        return `<tr><td class="tn">${horarioFaixa(h)}</td>${cells}<td class="tv" style="font-weight:700">${fF(tl)}</td></tr>`;
      }).join('');
      const totGeral = cats.reduce((s,c)=>s+(totCat[c]||0),0);
      catEl.innerHTML = `<thead><tr><th>Faixa</th>${cats.map(c=>`<th class="tv">${c}</th>`).join('')}<th class="tv">Total</th></tr></thead><tbody>${body}
        <tr style="font-weight:700"><td class="tn">TOTAL (com hora)</td>${cats.map(c=>`<td class="tv">${fF(totCat[c]||0)}</td>`).join('')}<td class="tv">${fF(totGeral)}</td></tr></tbody>`;
    }
  }

  // Exposição aditiva (mesmo padrão de renderDiario) — não lida por nenhuma aba hoje.
  return { label: rotulo, meses, picoReceita: picoR, picoPedidos: picoP, manha, tarde, noite,
    porHora: linhas, semHora: { r:A.semHora[0], c:A.semHora[1], pedidos:A.semHora[2] } };
}

const db = require('../config/db');

// Períodos que o ETL materializa a cada ciclo. Ajuste aqui p/ novos semestres.
const PERIODOS = [
  { key: '2026_1', label: '2026 - 1º Semestre', ini: '2026-01-01', fim: '2026-06-30' },
  { key: '2026_2', label: '2026 - 2º Semestre', ini: '2026-07-01', fim: '2026-12-31' },
  { key: '2025_1', label: '2025 - 1º Semestre', ini: '2025-01-01', fim: '2025-06-30' },
  { key: '2025_2', label: '2025 - 2º Semestre', ini: '2025-07-01', fim: '2025-12-31' },
];

// Categorias de meta (codcategoriaprod) — as 7 do painel. metacategoria.codmetacategoria = codcategoriaprod.
const META_CATS = [1, 2, 3, 4, 6, 8, 9];

// metacategoria.permargem (margem alvo) vem com escala inconsistente do ERP: 2026/07
// gravado como 0,273 (= 27,3%) e 2026/08 como 0,00273, para a mesma categoria. A
// planilha oficial de metas confirma que o alvo é 27,3% nos dois casos.
// Como margem de venda nunca é menor que 1%, valores < 0,01 são multiplicados por 100.
// Devolve SEMPRE fração (0,273), pronta para multiplicar pela meta de receita.
const normPermargem = col => `(case
    when coalesce(${col},0) = 0 then 0
    when ${col} < 0.01 then ${col} * 100
    else ${col} end)`;

// CTE base — o cubo de vendas do período, materializado em TEMP TABLE 1x por ciclo.
const BASE_CTE = `
  select
    s.*, subgrupos.codcategoriaprod as codcateg, categoriasproduto.descategoriaprod as categoria,
    Produtos.CodFor, EQFORD.Razfor As Fornecedor, Produtos.CodSubGrupo AS CodGru,
    SubGrupos.DesSubGrupo AS Grupo, Produtos.Desceq AS Descricao,
    1 - s.customedio / nullif(s.total,0) as margem,
    case when Produtos.siglaagrufat='PP' then s.Qtde else 0 end as realpapel,
    case when Produtos.siglaagrufat='FF' then s.Peso else 0 end as realkg,
    -- Estratégico = o PRODUTO está na lista (1.482 produtos em 16 famílias).
    -- Casar por codfamilia pegava os 957 produtos das mesmas famílias que NÃO estão
    -- na lista: R$ 282M marcados contra uma meta de R$ 5,5M (5118% de atingimento).
    -- Por codproduto dá R$ 4,79M vs meta 5,51M = 87%, coerente.
    -- Além disso o LEFT JOIN por codfamilia duplicava linha (até 674 por família) e
    -- inflava todo o cubo; EXISTS testa sem duplicar.
    case when exists (
      select 1 from cifalcomercial.produtos_estrategicos pe where pe.codproduto = Produtos.CodProduto
    ) then s.Total else 0 end as estrategico,
    -- Inadimplência resolvida por JOIN com a lista de clientes (UNION dedupa, então
    -- não multiplica linha) em vez de subconsulta correlacionada por linha — a
    -- versão correlacionada era reavaliada para cada uma das ~240 mil linhas.
    case when inad.codcli is not null then 'S' else 'N' end as inadimplente
  from (
    select
      supervisor.nomesupervisor as supervisor, supervisor.codgerente as codger,
      gerente.nomegerente as gerente, extract(month from Pedidos.DataFechamento) AS Mes,
      Pedidos.DataFechamento AS DataPed, Pedidos.CodCliente AS CodCli, EQCLID.NOMCLI AS Cliente,
      Pedidos.NroPedido AS NroPed, eqvend.Codsupervisor AS CodSup, eqvend.codgerente AS CodGerVen,
      Pedidos.CodVendedor AS CodVen, EQVEND.NOMVEN AS Vendedor, ItensPedido.CodProduto AS Codigo,
      (Case When coalesce(TotDescontoNota,0) > 0 then (ItensPedido.Qtde*ItensPedido.ValUni) * (1 - (TotDescontoNota/TotProdutos)) Else (ItensPedido.Qtde*ItensPedido.ValUni) End) AS Total,
      (ItensPedido.Qtde * UnidadeAlt.QdeEmb)/upadrao.qdeemb AS Qtde,
      ItensPedido.Qtde*UnidadeAlt.PesoLiq AS Peso,
      itenspedido.qtde * itenspedido.customedio as customedio,
      case when pedidos.codempresa = 501 and coalesce(pedidos.tipoempresa,0) in(0,501) then 'Cupom' else 'Danfe' end as tipo,
      case when pedidos.valdinheiro>0 then 'DINHEIRO' when pedidos.valcheque>0 then 'CHEQUE' when pedidos.valdup>0 then 'BOLETO' when pedidos.valorpix>0 then 'PIX' else 'OUTROS' end as tipocob,
      case when eqclid.sitcli = true then 'Inativo' else 'Ativo' end as status_cliente,
      pedidos.prazomedio as prazo_pagamento,
      a.desati as canal_vendas
    from cifalcomercial.Pedidos
    join cifalcomercial.ItensPedido on ItensPedido.NroPedido=Pedidos.NroPedido
    join cifalcomercial.UnidadeAlt on ItensPedido.CodProduto=UnidadeAlt.CodProduto and ItensPedido.Unidade=UnidadeAlt.Unidade
    left join cifalcomercial.unidadealt upadrao on upadrao.codproduto = itenspedido.codproduto and upadrao.unidpadrao ilike 's'
    join cifalcomercial.Eqvend on pedidos.codvendedor=eqvend.codven
    join cifalcomercial.EQCLID on Pedidos.CodCliente=EQCLID.CODCLI
    join cifalcomercial.Supervisor on Supervisor.CodSupervisor=eqvend.CodSupervisor
    join cifalcomercial.Gerente on Supervisor.CodGerente=Gerente.CodGerente
    left join cifalcomercial.atividades a on a.codati = eqclid.codati
    where Pedidos.Cancelado is null and Pedidos.CodTpo in(2,4,5)
    and pedidos.datafechamento::date >= $1
    and pedidos.datafechamento::date <= $2
  ) as s
  join cifalcomercial.Produtos on s.codigo=Produtos.CodProduto
  join cifalcomercial.SubGrupos on Produtos.CodSubGrupo=SubGrupos.CodSubGrupo
  join cifalcomercial.EQFORD on Produtos.CodFor=EQFORD.Codfor
  left join cifalcomercial.categoriasproduto on categoriasproduto.codcategoriaprod=subgrupos.codcategoriaprod
  left join (
    select codcli from cifalcomercial.creceber
    where datqui is null and datven::date < now()::date
    union
    select codcli from cifalcomercial.chqrec
    where dataDevolucao is not null and DatPag is null
      and Datadevolucao::date <= now() - '30 day'::interval
  ) inad on inad.codcli = s.codcli
`;

const num = v => parseFloat(v) || 0;
const round2 = v => Math.round(v * 100) / 100;
const margem = (r, c) => (r > 0 ? round2((1 - c / r) * 100) : 0);
const isoDay = v => new Date(v).toISOString().split('T')[0];
// nível hierárquico -> coluna da temp table
const LEVEL_COL = { gerente: 'gerente', supervisor: 'supervisor', vendedor: 'vendedor' };

class DashboardETLService {
  async _buildPeriodo(periodo) {
    const client = await db.getClient();
    const q = async (sql, params) => (await client.query(sql, params || [])).rows;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE tmp_base_vendas ON COMMIT DROP AS ${BASE_CTE}`, [periodo.ini, periodo.fim]);

      // ── agregados principais ───────────────────────────────────
      const resumo = (await q(`
        SELECT COUNT(*) linhas, SUM(Total) receita, SUM(customedio) custo, SUM(Qtde) qtde, SUM(Peso) peso,
               COUNT(DISTINCT CodCli) n_cli, COUNT(DISTINCT CodVen) n_vend, COUNT(DISTINCT CodSup) n_sup,
               COUNT(DISTINCT codger) n_ger, COUNT(DISTINCT Codigo) n_prod, COUNT(DISTINCT codcateg) n_cat,
               COUNT(DISTINCT CodGru) n_grp, COUNT(DISTINCT NroPed) n_pedidos
        FROM tmp_base_vendas`))[0];
      const porMes = await q(`SELECT Mes mes, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, COUNT(DISTINCT NroPed) pedidos FROM tmp_base_vendas GROUP BY Mes ORDER BY Mes`);
      // rp/rkg/rest = realizado de Papel (siglaagrufat PP), Kg (FF) e produtos
      // estratégicos — usados na aba Meta x Realizado.
      const porGer = await q(`SELECT gerente, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest FROM tmp_base_vendas GROUP BY gerente`);
      const porSup = await q(`SELECT supervisor, gerente, SUM(Total) r, SUM(customedio) c, SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest FROM tmp_base_vendas GROUP BY supervisor, gerente`);
      // Mesmo recorte de porGer/porSup/fullVend, mas por MÊS — usado para comparar
      // Meta x Realizado de KG Fumo/Papel/Estratégico no mês selecionado (ST.mes),
      // em vez do semestre inteiro, quando há filtro de Gerente/Supervisor/Vendedor.
      const porGerMes = await q(`SELECT gerente, Mes mes, SUM(Total) r, SUM(customedio) c, SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest FROM tmp_base_vendas GROUP BY gerente, Mes`);
      const porSupMes = await q(`SELECT supervisor, Mes mes, SUM(Total) r, SUM(customedio) c, SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest FROM tmp_base_vendas GROUP BY supervisor, Mes`);
      const porVendMes = await q(`SELECT Vendedor nome, Mes mes, SUM(Total) r, SUM(customedio) c, SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest FROM tmp_base_vendas WHERE Vendedor IS NOT NULL GROUP BY Vendedor, Mes`);
      const porCat = await q(`SELECT categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(Peso) p, COUNT(DISTINCT CodCli) n_clientes FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY categoria`);
      const porGrp = await q(`SELECT Grupo grupo, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(Peso) p FROM tmp_base_vendas WHERE Grupo IS NOT NULL GROUP BY Grupo, categoria`);
      const topVend = await q(`SELECT CodVen codigo, Vendedor nome, supervisor, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq FROM tmp_base_vendas WHERE Vendedor IS NOT NULL GROUP BY CodVen, Vendedor, supervisor ORDER BY r DESC LIMIT 50`);
      const topCli = await q(`SELECT CodCli codigo, Cliente nome, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, COUNT(DISTINCT Mes) meses_ativos, COUNT(DISTINCT codcateg) categorias FROM tmp_base_vendas WHERE Cliente IS NOT NULL GROUP BY CodCli, Cliente ORDER BY r DESC LIMIT 50`);
      const topProd = await q(`SELECT Codigo codigo, Descricao nome, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq FROM tmp_base_vendas WHERE Descricao IS NOT NULL GROUP BY Codigo, Descricao, categoria ORDER BY r DESC LIMIT 50`);
      // DataPed é timestamp (DataFechamento) e parte das linhas tem hora ≠ 00:00 — agrupar
      // pelo timestamp cru gera VÁRIOS grupos para o mesmo dia, que ao virarem chave de
      // dia no JSON se sobrescreviam e perdiam receita. ::date resolve na origem.
      const porDia = await q(`SELECT DataPed::date dia, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas GROUP BY DataPed::date ORDER BY 1`);
      const porDiaCat = await q(`SELECT DataPed::date dia, categoria, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY DataPed::date, categoria ORDER BY 1`);
      const porCanal = await q(`SELECT canal_vendas, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, COUNT(DISTINCT CodCli) n_clientes FROM tmp_base_vendas WHERE canal_vendas IS NOT NULL GROUP BY canal_vendas`);
      const porInadimplente = await q(`SELECT inadimplente, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, COUNT(DISTINCT CodCli) n_clientes FROM tmp_base_vendas GROUP BY inadimplente`);
      const porStatus = await q(`SELECT status_cliente, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, COUNT(DISTINCT CodCli) n_clientes FROM tmp_base_vendas GROUP BY status_cliente`);

      // ── extras "flat" (antes vinham do snapshot) ───────────────
      const porMesCli = await q(`SELECT Mes mes, COUNT(DISTINCT CodCli) n FROM tmp_base_vendas GROUP BY Mes`);
      const porMesCatCli = await q(`SELECT Mes mes, categoria, COUNT(DISTINCT CodCli) n FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY Mes, categoria`);
      // Códigos de cliente distintos por (mês, categoria) — não só a contagem —
      // pra permitir deduplicar no front ao somar vários meses de um período
      // (Bimestre/Quadrimestre/Semestre/Personalizado): um cliente que comprou
      // em mais de um mês do período não pode ser contado 2x na Positivação.
      const porMesCatCliCod = await q(`SELECT Mes mes, categoria, array_agg(DISTINCT CodCli) codigos FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY Mes, categoria`);
      // Realizado da meta FUMO KG (metacategoria cat 13) = peso dos produtos com
      // siglaagrufat='FF' — é a coluna realkg, a mesma que a query oficial usa.
      // Não é "Grupo ILIKE 'fumo%'": esse filtro pega grupos que não entram na meta.
      const porMesFumo = await q(`SELECT Mes mes, SUM(realkg) kg FROM tmp_base_vendas GROUP BY Mes`);
      const realFumoGer = await q(`SELECT gerente k, SUM(realkg) kg FROM tmp_base_vendas GROUP BY gerente`);
      const realFumoSup = await q(`SELECT supervisor k, SUM(realkg) kg FROM tmp_base_vendas GROUP BY supervisor`);
      const realFumoVend = await q(`SELECT Vendedor k, SUM(realkg) kg FROM tmp_base_vendas GROUP BY Vendedor`);
      // Peso total do grupo "fumo*" (conceito diferente da meta) p/ visões de volume.
      const porMesFumoTotal = await q(`SELECT Mes mes, SUM(Peso) kg FROM tmp_base_vendas WHERE Grupo ILIKE 'fumo%' GROUP BY Mes`);
      // MIN(CodVen) só identifica o vendedor (p/ exibir "código - nome" no front) —
      // não entra no GROUP BY p/ não fragmentar a agregação caso o mesmo nome tenha
      // mais de um CodVen cadastrado (mesmo risco já aceito em topVendCash).
      const fullVend = await q(`SELECT MIN(CodVen) codigo, Vendedor nome, supervisor, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq, SUM(realpapel) rp, SUM(realkg) rkg, SUM(estrategico) rest FROM tmp_base_vendas WHERE Vendedor IS NOT NULL GROUP BY Vendedor, supervisor`);
      const qual = (await q(`SELECT
          COUNT(*) FILTER (WHERE CodCli IS NULL) sem_cli, COUNT(*) FILTER (WHERE Codigo IS NULL) sem_prod,
          COUNT(*) FILTER (WHERE CodVen IS NULL) sem_vend, COUNT(*) FILTER (WHERE Total<=0) rec_zero,
          COUNT(*) FILTER (WHERE Qtde<=0) qtd_zero, COUNT(*) FILTER (WHERE customedio>Total) custo_maior
        FROM tmp_base_vendas`))[0];
      const topCliCash = await q(`SELECT CodCli codigo, Cliente nome, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas WHERE Cliente IS NOT NULL GROUP BY CodCli, Cliente ORDER BY (SUM(Total)-SUM(customedio)) DESC LIMIT 50`);
      // Cascata da aba Cash Margem (Top 50 Clientes): faturamento por categoria +
      // vendedor/supervisor responsável por cada um desses 50 clientes — só roda
      // p/ os codcli do topCliCash acima (não precisa da base inteira).
      const topCliCashCodes = topCliCash.map(r => r.codigo);
      const topCliCashCat = topCliCashCodes.length ? await q(`
        SELECT CodCli codigo, categoria, SUM(Total) r, SUM(customedio) c
        FROM tmp_base_vendas WHERE CodCli = ANY($1::int[]) AND categoria IS NOT NULL
        GROUP BY CodCli, categoria`, [topCliCashCodes]) : [];
      const topCliCashVend = topCliCashCodes.length ? await q(`
        SELECT CodCli codigo, CodVen vcodigo, Vendedor vnome, supervisor, SUM(Total) r
        FROM tmp_base_vendas WHERE CodCli = ANY($1::int[]) AND Vendedor IS NOT NULL
        GROUP BY CodCli, CodVen, Vendedor, supervisor ORDER BY CodCli, SUM(Total) DESC`, [topCliCashCodes]) : [];
      const topProdCash = await q(`SELECT Codigo codigo, Descricao nome, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq FROM tmp_base_vendas WHERE Descricao IS NOT NULL GROUP BY Codigo, Descricao, categoria ORDER BY (SUM(Total)-SUM(customedio)) DESC LIMIT 50`);
      const topVendCash = await q(`SELECT CodVen codigo, Vendedor nome, supervisor, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas WHERE Vendedor IS NOT NULL GROUP BY CodVen, Vendedor, supervisor ORDER BY (SUM(Total)-SUM(customedio)) DESC LIMIT 50`);
      // Top 50 por MARGEM % (razão), não por Cash Margem (R$) — rankings diferentes
      // (cliente/produto/vendedor com faturamento pequeno e margem alta entra aqui
      // e pode não entrar no Top 50 por Cash Margem). HAVING SUM(Total)>=500 evita
      // que uma única venda de poucos reais (ex.: baixa de avaria) domine o Top 50
      // só por ter custo perto de zero — sem o piso, os 4-5 primeiros lugares eram
      // sempre itens de R$5-30 com 100% de margem, sem relevância de negócio.
      const topCliMargem = await q(`SELECT CodCli codigo, Cliente nome, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas WHERE Cliente IS NOT NULL AND Total>0 GROUP BY CodCli, Cliente HAVING SUM(Total)>=500 ORDER BY (1-SUM(customedio)/SUM(Total)) DESC LIMIT 50`);
      const topProdMargem = await q(`SELECT Codigo codigo, Descricao nome, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq FROM tmp_base_vendas WHERE Descricao IS NOT NULL AND Total>0 GROUP BY Codigo, Descricao, categoria HAVING SUM(Total)>=500 ORDER BY (1-SUM(customedio)/SUM(Total)) DESC LIMIT 50`);
      // Mesma cascata do Top 50 Clientes por Cash Margem (categoria + vendedor/
      // supervisor), agora para os codcli do Top 50 por MARGEM % — são clientes
      // DIFERENTES do Top 50 por Cash Margem (rankings não se sobrepõem).
      const topCliMargemCodes = topCliMargem.map(r => r.codigo);
      const topCliMargemCat = topCliMargemCodes.length ? await q(`
        SELECT CodCli codigo, categoria, SUM(Total) r, SUM(customedio) c
        FROM tmp_base_vendas WHERE CodCli = ANY($1::int[]) AND categoria IS NOT NULL
        GROUP BY CodCli, categoria`, [topCliMargemCodes]) : [];
      const topCliMargemVend = topCliMargemCodes.length ? await q(`
        SELECT CodCli codigo, CodVen vcodigo, Vendedor vnome, supervisor, SUM(Total) r
        FROM tmp_base_vendas WHERE CodCli = ANY($1::int[]) AND Vendedor IS NOT NULL
        GROUP BY CodCli, CodVen, Vendedor, supervisor ORDER BY CodCli, SUM(Total) DESC`, [topCliMargemCodes]) : [];
      const topVendMargem = await q(`SELECT CodVen codigo, Vendedor nome, supervisor, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas WHERE Vendedor IS NOT NULL AND Total>0 GROUP BY CodVen, Vendedor, supervisor ORDER BY (1-SUM(customedio)/SUM(Total)) DESC LIMIT 50`);

      // ── Top 50 Cliente/Produto POR MÊS (Cash Margem e Margem %) ────────────
      // O filtro de Mês do painel (ST.mes) precisa de um Top 50 PRÓPRIO por mês —
      // um cliente pode ser Top 50 no semestre e não num mês específico, e
      // vice-versa. Vendedor NÃO precisa disso: full_vendedores/realizado_por_mes
      // já cobrem TODOS os vendedores por mês, então o Top 50 mensal é calculado
      // no front a partir desse cubo (sem query nova).
      const cliCashPorMes = await q(`SELECT codigo, nome, mes, r, c FROM (
        SELECT CodCli codigo, Cliente nome, Mes mes, SUM(Total) r, SUM(customedio) c,
          ROW_NUMBER() OVER (PARTITION BY Mes ORDER BY (SUM(Total)-SUM(customedio)) DESC) rn
        FROM tmp_base_vendas WHERE Cliente IS NOT NULL GROUP BY CodCli, Cliente, Mes
      ) t WHERE rn<=50 ORDER BY mes, rn`);
      const cliMargemPorMes = await q(`SELECT codigo, nome, mes, r, c FROM (
        SELECT CodCli codigo, Cliente nome, Mes mes, SUM(Total) r, SUM(customedio) c,
          ROW_NUMBER() OVER (PARTITION BY Mes ORDER BY (1-SUM(customedio)/SUM(Total)) DESC) rn
        FROM tmp_base_vendas WHERE Cliente IS NOT NULL AND Total>0 GROUP BY CodCli, Cliente, Mes
        HAVING SUM(Total)>=500
      ) t WHERE rn<=50 ORDER BY mes, rn`);
      const prodCashPorMes = await q(`SELECT codigo, nome, categoria, mes, r, c, qq FROM (
        SELECT Codigo codigo, Descricao nome, categoria, Mes mes, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
          ROW_NUMBER() OVER (PARTITION BY Mes ORDER BY (SUM(Total)-SUM(customedio)) DESC) rn
        FROM tmp_base_vendas WHERE Descricao IS NOT NULL GROUP BY Codigo, Descricao, categoria, Mes
      ) t WHERE rn<=50 ORDER BY mes, rn`);
      const prodMargemPorMes = await q(`SELECT codigo, nome, categoria, mes, r, c, qq FROM (
        SELECT Codigo codigo, Descricao nome, categoria, Mes mes, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
          ROW_NUMBER() OVER (PARTITION BY Mes ORDER BY (1-SUM(customedio)/SUM(Total)) DESC) rn
        FROM tmp_base_vendas WHERE Descricao IS NOT NULL AND Total>0 GROUP BY Codigo, Descricao, categoria, Mes
        HAVING SUM(Total)>=500
      ) t WHERE rn<=50 ORDER BY mes, rn`);

      // Cascata (categoria + vendedor/supervisor) de TODOS os clientes que aparecem
      // em QUALQUER Top 50 de cliente (semestre ou por mês, Cash ou Margem) — uma
      // query só, com quebra por mês (soma-se no front p/ ver o semestre).
      const allCliCodes = [...new Set([
        ...topCliCash.map(r=>r.codigo), ...topCliMargem.map(r=>r.codigo),
        ...cliCashPorMes.map(r=>r.codigo), ...cliMargemPorMes.map(r=>r.codigo),
      ])];
      const cliCatPorMes = allCliCodes.length ? await q(`
        SELECT CodCli codigo, Mes mes, categoria, SUM(Total) r, SUM(customedio) c
        FROM tmp_base_vendas WHERE CodCli = ANY($1::int[]) AND categoria IS NOT NULL
        GROUP BY CodCli, Mes, categoria`, [allCliCodes]) : [];
      const cliVendPorMes = allCliCodes.length ? await q(`
        SELECT CodCli codigo, Mes mes, CodVen vcodigo, Vendedor vnome, supervisor, SUM(Total) r
        FROM tmp_base_vendas WHERE CodCli = ANY($1::int[]) AND Vendedor IS NOT NULL
        GROUP BY CodCli, Mes, CodVen, Vendedor, supervisor ORDER BY CodCli, Mes, SUM(Total) DESC`, [allCliCodes]) : [];

      // Ano anterior (mesmo range de datas, ano-1) para esses MESMOS codcli — sem
      // isso, o comparativo do cliente no efeito cascata só existiria se ele TAMBÉM
      // estivesse no Top 50 do ano passado (raro: rankings de anos diferentes quase
      // não se sobrepõem). Reaproveita o BASE_CTE (mesmas regras de categoria/
      // desconto/custo do resto do painel) só trocando o range de datas e filtrando
      // pelos codcli — não recria o cubo inteiro do ano anterior.
      const prevAno = parseInt(periodo.ini.slice(0, 4), 10) - 1;
      const prevIni = `${prevAno}${periodo.ini.slice(4)}`;
      const prevFim = `${prevAno}${periodo.fim.slice(4)}`;
      const cliCatPorMesAnoAnterior = allCliCodes.length ? await q(`
        SELECT codcli codigo, mes, categoria, SUM(total) r, SUM(customedio) c
        FROM (${BASE_CTE}) base
        WHERE base.codcli = ANY($3::int[])
        GROUP BY codcli, mes, categoria`, [prevIni, prevFim, allCliCodes]) : [];

      const pag = await q(`SELECT categoria, tipo, tipocob, SUM(Total) v FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY categoria, tipo, tipocob`);
      const janRange = (await q(`SELECT MIN(DataPed) ini, MAX(DataPed) fim FROM tmp_base_vendas`))[0];
      const janProd = await q(`SELECT Codigo codigo, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq FROM tmp_base_vendas WHERE DataPed >= (SELECT MAX(DataPed) FROM tmp_base_vendas) - INTERVAL '89 days' GROUP BY Codigo`);
      const abcdCli = await q(`SELECT Cliente nome, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas WHERE Cliente IS NOT NULL GROUP BY CodCli, Cliente`);

      // ── cubos hierárquicos (por gerente/supervisor/vendedor) ────
      const hierTopCli = {}, hierTopProd = {}, hierCat = {}, hierPag = {}, hierAbcdRows = {};
      for (const [lvl, col] of Object.entries(LEVEL_COL)) {
        hierTopCli[lvl] = await q(`SELECT ent, codigo, nome, r, c, qq FROM (
          SELECT "${col}" ent, CodCli codigo, Cliente nome, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
                 ROW_NUMBER() OVER (PARTITION BY "${col}" ORDER BY SUM(Total) DESC) rn
          FROM tmp_base_vendas WHERE Cliente IS NOT NULL GROUP BY "${col}", CodCli, Cliente) t WHERE rn<=50`);
        hierTopProd[lvl] = await q(`SELECT ent, codigo, nome, categoria, r, c, qq FROM (
          SELECT "${col}" ent, Codigo codigo, Descricao nome, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq,
                 ROW_NUMBER() OVER (PARTITION BY "${col}" ORDER BY SUM(Total) DESC) rn
          FROM tmp_base_vendas WHERE Descricao IS NOT NULL GROUP BY "${col}", Codigo, Descricao, categoria) t WHERE rn<=50`);
        hierCat[lvl] = await q(`SELECT "${col}" ent, categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) qq FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY "${col}", categoria`);
        hierPag[lvl] = await q(`SELECT "${col}" ent, categoria, tipo, tipocob, SUM(Total) v FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY "${col}", categoria, tipo, tipocob`);
        hierAbcdRows[lvl] = await q(`SELECT "${col}" ent, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas WHERE Cliente IS NOT NULL GROUP BY "${col}", CodCli`);
      }
      const hierDiaGer = await q(`SELECT gerente ent, DataPed::date dia, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas GROUP BY gerente, DataPed::date`);
      const hierDiaCatGer = await q(`SELECT gerente ent, DataPed::date dia, categoria, SUM(Total) r, SUM(customedio) c FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY gerente, DataPed::date, categoria`);

      // ── cascata (Categoria → Grupo → Fornecedor → Produto) ─────
      // n_cli é distinto POR NÍVEL (não soma dos filhos), por isso queries separadas.
      const cascCat = await q(`SELECT categoria, SUM(Total) r, SUM(customedio) c, SUM(Qtde) q, SUM(Peso) p, COUNT(DISTINCT CodCli) n_cli, COUNT(DISTINCT Grupo) n_grp FROM tmp_base_vendas WHERE categoria IS NOT NULL GROUP BY categoria`);
      const cascGrp = await q(`SELECT categoria, Grupo grupo, SUM(Total) r, SUM(customedio) c, SUM(Qtde) q, SUM(Peso) p, COUNT(DISTINCT CodCli) n_cli, COUNT(DISTINCT Fornecedor) n_for FROM tmp_base_vendas WHERE categoria IS NOT NULL AND Grupo IS NOT NULL GROUP BY categoria, Grupo`);
      const cascForn = await q(`SELECT categoria, Grupo grupo, Fornecedor fornecedor, SUM(Total) r, SUM(customedio) c, SUM(Qtde) q, SUM(Peso) p, COUNT(DISTINCT CodCli) n_cli, COUNT(DISTINCT Codigo) n_prod FROM tmp_base_vendas WHERE categoria IS NOT NULL AND Grupo IS NOT NULL AND Fornecedor IS NOT NULL GROUP BY categoria, Grupo, Fornecedor`);
      const cascProd = await q(`SELECT categoria, Grupo grupo, Fornecedor fornecedor, Descricao produto, SUM(Total) r, SUM(customedio) c, SUM(Qtde) q, SUM(Peso) p, COUNT(DISTINCT CodCli) n_cli FROM tmp_base_vendas WHERE categoria IS NOT NULL AND Grupo IS NOT NULL AND Fornecedor IS NOT NULL AND Descricao IS NOT NULL GROUP BY categoria, Grupo, Fornecedor, Descricao`);

      // ── meta (tabelas de meta do banco) ────────────────────────
      const ano = parseInt(periodo.ini.slice(0, 4), 10);
      const mesIni = parseInt(periodo.ini.slice(5, 7), 10);
      const mesFim = parseInt(periodo.fim.slice(5, 7), 10);
      const meta = await this._buildMeta(client, ano, mesIni, mesFim);

      await client.query('COMMIT');

      return this._montarJson(periodo, {
        resumo, porMes, porGer, porSup, porCat, porGrp, topVend, topCli, topProd, porDia, porDiaCat,
        porGerMes, porSupMes, porVendMes,
        porMesCli, porMesCatCli, porMesCatCliCod, porMesFumo, porMesFumoTotal, realFumoGer, realFumoSup, realFumoVend, fullVend, qual,
        topCliCash, topCliCashCat, topCliCashVend, topProdCash, topVendCash,
        topCliMargem, topCliMargemCat, topCliMargemVend, topProdMargem, topVendMargem,
        cliCashPorMes, cliMargemPorMes, prodCashPorMes, prodMargemPorMes,
        cliCatPorMes, cliVendPorMes, cliCatPorMesAnoAnterior,
        pag, janRange, janProd, abcdCli,
        hierTopCli, hierTopProd, hierCat, hierPag, hierAbcdRows, hierDiaGer, hierDiaCatGer, meta,
        cascCat, cascGrp, cascForn, cascProd,
        porCanal, porInadimplente, porStatus
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Meta a partir de metacategoria (R$ por categoria/vendedor/mês) + metasanualporvendedor (kg fumo).
  async _buildMeta(client, ano, mesIni, mesFim) {
    const q = async (sql, params) => (await client.query(sql, params)).rows;
    const inCats = META_CATS.join(',');
    // Hierarquia da meta: o gerente vem do SUPERVISOR do vendedor (mesmo caminho do
    // BASE_CTE: eqvend → supervisor → gerente). Ligar por eqvend.codgerente estava
    // errado — 310 dos 1.171 vendedores têm eqvend.codgerente ≠ supervisor.codgerente,
    // o que jogava meta para o gerente errado e criava um grupo órfão (gerente null).
    // Efeito medido no G02/2026 S1: meta de papel 11.754 (errado) vs 14.897 (correto).
    //
    // FUMO KG: a meta é a categoria 13 de metacategoria (mesma fonte das outras) —
    // metasanualporvendedor.kgfumo tem outro conteúdo (só 1 supervisor cadastrado) e
    // não é a meta que o painel compara.
    const vendRows = await q(`
      SELECT e.codven, e.nomven nome, g.nomegerente gerente, s.nomesupervisor supervisor,
             mc.meta_geral, mc.meta_papel, mc.meta_kg, mc.meta_estrategico,
             mc.meta_fumokg, mc.meta_valrentabilidade, mc.meta_permargem
      FROM (SELECT codven,
            SUM(case when codmetacategoria IN (${inCats}) AND codmetacategoria not in (12,13,14) then valor else 0 end) meta_geral,
            SUM(case when codmetacategoria=14 then valor else 0 end) meta_papel,
            SUM(case when codmetacategoria=13 then valor else 0 end) meta_kg,
            SUM(case when codmetacategoria=13 then valor else 0 end) meta_fumokg,
            SUM(case when codmetacategoria=12 then valor else 0 end) meta_estrategico,
            -- Meta de rentabilidade (Cash Margem alvo) = meta de receita x margem alvo.
            -- valrentabilidade está zerada desde 2026, então usamos permargem.
            --
            -- A ESCALA DE permargem É INCONSISTENTE NO ERP: 2026/07 está como 0,273
            -- (fração de 27,3%) e 2026/08 como 0,00273 — 100x menor, para a MESMA
            -- categoria. Conferido com a planilha oficial "Rev Forescast AGO26": a Meta
            -- Cash Margem de agosto da cat 3 é 13.383.825 = 49.025.000 x 0,273, ou seja
            -- agosto foi digitado com 2 casas a mais. normPermargem() abaixo reescala
            -- valores < 0,01 (nenhuma margem real de venda é menor que 1%).
            SUM(case when codmetacategoria IN (${inCats}) AND codmetacategoria not in (12,13,14)
                     then valor * ${normPermargem('permargem')} else 0 end) meta_valrentabilidade,
            MAX(${normPermargem('permargem')}) meta_permargem
            FROM cifalcomercial.metacategoria
            WHERE ano=$1 AND mes BETWEEN $2 AND $3 GROUP BY codven) mc
      JOIN cifalcomercial.eqvend e ON e.codven=mc.codven
      LEFT JOIN cifalcomercial.supervisor s ON s.codsupervisor=e.codsupervisor
      LEFT JOIN cifalcomercial.gerente g ON g.codgerente=s.codgerente`,
      [ano, mesIni, mesFim]);
    // permargem aqui dá a Meta Cash Margem POR CATEGORIA (meta receita x margem
    // alvo daquela categoria) — mesma conta já usada para a meta de rentabilidade
    // da empresa/gerente/supervisor/vendedor, só que sem misturar categorias.
    const catRows = await q(`
      SELECT c.descategoriaprod categoria, SUM(mc.valor) meta, MAX(${normPermargem('mc.permargem')}) permargem
      FROM cifalcomercial.metacategoria mc
      JOIN cifalcomercial.categoriasproduto c ON c.codcategoriaprod=mc.codmetacategoria
      WHERE mc.ano=$1 AND mc.mes BETWEEN $2 AND $3 AND mc.codmetacategoria IN (${inCats})
      GROUP BY c.descategoriaprod`, [ano, mesIni, mesFim]);
    const mesCatRows = await q(`
      SELECT mc.mes, c.descategoriaprod categoria, SUM(mc.valor) meta, MAX(${normPermargem('mc.permargem')}) permargem
      FROM cifalcomercial.metacategoria mc
      JOIN cifalcomercial.categoriasproduto c ON c.codcategoriaprod=mc.codmetacategoria
      WHERE mc.ano=$1 AND mc.mes BETWEEN $2 AND $3 AND mc.codmetacategoria IN (${inCats})
      GROUP BY mc.mes, c.descategoriaprod`, [ano, mesIni, mesFim]);
    // Meta por MÊS e por entidade — sem isso o filtro de Mês compararia o realizado
    // de um mês com a meta do semestre inteiro.
    const mesEntRows = await q(`
      SELECT mc.mes, g.nomegerente gerente, s.nomesupervisor supervisor, e.nomven vendedor,
             SUM(case when mc.codmetacategoria IN (${inCats}) AND mc.codmetacategoria not in (12,13,14) then mc.valor else 0 end) meta_geral,
             SUM(case when mc.codmetacategoria IN (${inCats}) AND mc.codmetacategoria not in (12,13,14)
                      then mc.valor * ${normPermargem('mc.permargem')} else 0 end) meta_valrentabilidade,
             SUM(case when mc.codmetacategoria=14 then mc.valor else 0 end) meta_papel,
             SUM(case when mc.codmetacategoria=13 then mc.valor else 0 end) meta_kg,
             SUM(case when mc.codmetacategoria=12 then mc.valor else 0 end) meta_estrategico,
             MAX(${normPermargem('mc.permargem')}) meta_permargem
      FROM cifalcomercial.metacategoria mc
      JOIN cifalcomercial.eqvend e ON e.codven=mc.codven
      LEFT JOIN cifalcomercial.supervisor s ON s.codsupervisor=e.codsupervisor
      LEFT JOIN cifalcomercial.gerente g ON g.codgerente=s.codgerente
      WHERE mc.ano=$1 AND mc.mes BETWEEN $2 AND $3
      GROUP BY mc.mes, g.nomegerente, s.nomesupervisor, e.nomven`, [ano, mesIni, mesFim]);

    // Meta por MÊS + hierarquia (Gerente/Supervisor/Vendedor) + CATEGORIA — sem
    // isso, a tabela "por Categoria" da aba Acompanhamento Objetivos não tinha
    // como respeitar um filtro de Gerente/Supervisor/Vendedor: só existia meta
    // por (mês x hierarquia) OU por (mês x categoria), nunca as duas juntas.
    const mesEntCatRows = await q(`
      SELECT mc.mes, g.nomegerente gerente, s.nomesupervisor supervisor, e.nomven vendedor,
             c.descategoriaprod categoria, SUM(mc.valor) meta, MAX(${normPermargem('mc.permargem')}) permargem
      FROM cifalcomercial.metacategoria mc
      JOIN cifalcomercial.eqvend e ON e.codven=mc.codven
      LEFT JOIN cifalcomercial.supervisor s ON s.codsupervisor=e.codsupervisor
      LEFT JOIN cifalcomercial.gerente g ON g.codgerente=s.codgerente
      JOIN cifalcomercial.categoriasproduto c ON c.codcategoriaprod=mc.codmetacategoria
      WHERE mc.ano=$1 AND mc.mes BETWEEN $2 AND $3 AND mc.codmetacategoria IN (${inCats})
      GROUP BY mc.mes, g.nomegerente, s.nomesupervisor, e.nomven, c.descategoriaprod`, [ano, mesIni, mesFim]);

    // A query traz meta_papel (cat 14), meta_kg (13), meta_estrategico (12),
    // meta_valrentabilidade e meta_permargem — todos precisam ser copiados para o
    // JSON, senão a aba Meta x Realizado fica sem a meta desses indicadores.
    const SOMAVEIS = ['meta_geral', 'meta_fumokg', 'meta_papel', 'meta_kg', 'meta_estrategico', 'meta_valrentabilidade'];
    const zeros = extra => Object.assign(SOMAVEIS.reduce((o, k) => { o[k] = 0; return o; }, { meta_permargem: 0 }), extra || {});
    const por_vendedor = {}, por_supervisor = {}, por_gerente = {};
    for (const r of vendRows) {
      if (!r.nome) continue;
      const v = {};
      for (const k of SOMAVEIS) v[k] = num(r[k]);
      const pm = num(r.meta_permargem);
      por_vendedor[r.nome] = Object.assign({}, ...SOMAVEIS.map(k => ({ [k]: round2(v[k]) })), { meta_permargem: round2(pm), supervisor: r.supervisor });
      const acumular = alvo => {
        for (const k of SOMAVEIS) alvo[k] += v[k];
        // % de margem é meta relativa: soma não faz sentido, usamos o maior do grupo.
        alvo.meta_permargem = Math.max(alvo.meta_permargem, pm);
      };
      if (r.supervisor) {
        if (!por_supervisor[r.supervisor]) por_supervisor[r.supervisor] = zeros({ gerente: r.gerente });
        acumular(por_supervisor[r.supervisor]);
      }
      if (r.gerente) {
        if (!por_gerente[r.gerente]) por_gerente[r.gerente] = zeros();
        acumular(por_gerente[r.gerente]);
      }
    }
    for (const dict of [por_supervisor, por_gerente]) {
      for (const k in dict) for (const campo of SOMAVEIS) dict[k][campo] = round2(dict[k][campo]);
    }
    const por_categoria = {};
    const por_categoria_valrentabilidade = {};
    for (const r of catRows) {
      const metaVal = round2(num(r.meta));
      por_categoria[r.categoria] = metaVal;
      por_categoria_valrentabilidade[r.categoria] = round2(metaVal * num(r.permargem));
    }
    const por_mes_categoria = {};
    const por_mes_categoria_valrentabilidade = {};
    for (const r of mesCatRows) {
      const m = String(r.mes);
      const metaVal = round2(num(r.meta));
      (por_mes_categoria[m] = por_mes_categoria[m] || {})[r.categoria] = metaVal;
      (por_mes_categoria_valrentabilidade[m] = por_mes_categoria_valrentabilidade[m] || {})[r.categoria] = round2(metaVal * num(r.permargem));
    }

    // por_mes = { "7": { gerente:{nome:{...}}, supervisor:{...}, vendedor:{...} } }
    const CAMPOS_MES = ['meta_geral', 'meta_valrentabilidade', 'meta_papel', 'meta_kg', 'meta_estrategico'];
    const por_mes = {};
    for (const r of mesEntRows) {
      const m = String(r.mes);
      const noMes = por_mes[m] || (por_mes[m] = { gerente: {}, supervisor: {}, vendedor: {} });
      const pm = num(r.meta_permargem);
      [['gerente', r.gerente], ['supervisor', r.supervisor], ['vendedor', r.vendedor]].forEach(([nivel, nome]) => {
        if (!nome) return;
        const alvo = noMes[nivel][nome] || (noMes[nivel][nome] = Object.assign(
          CAMPOS_MES.reduce((o, k) => { o[k] = 0; return o; }, {}), { meta_permargem: 0 }));
        for (const k of CAMPOS_MES) alvo[k] += num(r[k]);
        alvo.meta_permargem = Math.max(alvo.meta_permargem, pm);
      });
    }
    for (const m in por_mes) for (const nivel in por_mes[m]) for (const nome in por_mes[m][nivel]) {
      const o = por_mes[m][nivel][nome];
      for (const k of CAMPOS_MES) o[k] = round2(o[k]);
      o.meta_permargem = round2(o.meta_permargem);
    }

    // hier_por_mes_categoria[nivel][mes][nome][categoria] = {meta, metaCash} —
    // meta de Faturamento e Cash Margem (meta x margem alvo) por categoria,
    // recortada por Gerente/Supervisor/Vendedor E por mês simultaneamente.
    const hier_por_mes_categoria = { gerente: {}, supervisor: {}, vendedor: {} };
    for (const r of mesEntCatRows) {
      const m = String(r.mes);
      const metaVal = num(r.meta);
      const metaCash = metaVal * num(r.permargem);
      [['gerente', r.gerente], ['supervisor', r.supervisor], ['vendedor', r.vendedor]].forEach(([nivel, nome]) => {
        if (!nome) return;
        const porNivel = hier_por_mes_categoria[nivel];
        const porMes = porNivel[m] || (porNivel[m] = {});
        const porNome = porMes[nome] || (porMes[nome] = {});
        const cur = porNome[r.categoria] || (porNome[r.categoria] = { meta: 0, metaCash: 0 });
        cur.meta += metaVal; cur.metaCash += metaCash;
      });
    }
    for (const nivel in hier_por_mes_categoria) for (const m in hier_por_mes_categoria[nivel]) for (const nome in hier_por_mes_categoria[nivel][m]) for (const cat in hier_por_mes_categoria[nivel][m][nome]) {
      const o = hier_por_mes_categoria[nivel][m][nome][cat];
      o.meta = round2(o.meta); o.metaCash = round2(o.metaCash);
    }

    return { linhas: vendRows.length, por_gerente, por_supervisor, por_vendedor, por_categoria, por_categoria_valrentabilidade, por_mes_categoria, por_mes_categoria_valrentabilidade, por_mes, hier_por_mes_categoria };
  }

  _montarJson(periodo, d) {
    const receita = num(d.resumo.receita), custo = num(d.resumo.custo);
    const nPedidos = parseInt(d.resumo.n_pedidos, 10) || 0;

    const por_mes = {};
    for (const row of d.porMes) { const r = num(row.r), c = num(row.c); por_mes[String(row.mes)] = { r: round2(r), c: round2(c), q: round2(num(row.qq)), m: margem(r, c), pedidos: parseInt(row.pedidos, 10) }; }
    // nomegerente/nomesupervisor no DB já vêm prefixados ("G01 - EDUARDO") — usar direto.
    const por_gerente = {};
    for (const row of d.porGer) { const r = num(row.r), c = num(row.c); por_gerente[row.gerente] = { r: round2(r), c: round2(c), q: round2(num(row.qq)), m: margem(r, c), rp: round2(num(row.rp)), rkg: round2(num(row.rkg)), rest: round2(num(row.rest)) }; }
    const por_supervisor = {};
    for (const row of d.porSup) { const r = num(row.r), c = num(row.c); por_supervisor[row.supervisor] = { r: round2(r), c: round2(c), m: margem(r, c), rp: round2(num(row.rp)), rkg: round2(num(row.rkg)), rest: round2(num(row.rest)), gerente: row.gerente }; }
    const por_categoria = {};
    for (const row of d.porCat) { const r = num(row.r), c = num(row.c); por_categoria[row.categoria] = { r: round2(r), c: round2(c), q: round2(num(row.qq)), p: round2(num(row.p)), m: margem(r, c), n_clientes: parseInt(row.n_clientes, 10) }; }
    const por_grupo = {};
    for (const row of d.porGrp) { const r = num(row.r), c = num(row.c); por_grupo[row.grupo] = { r: round2(r), c: round2(c), q: round2(num(row.qq)), p: round2(num(row.p)), m: margem(r, c), categoria: row.categoria }; }

    const mapTop = (rows, extra) => rows.map(row => { const r = num(row.r), c = num(row.c); return Object.assign({ codigo: String(row.codigo), nome: row.nome, r: round2(r), c: round2(c), q: round2(num(row.qq)), m: margem(r, c) }, extra ? extra(row) : {}); });
    const top_vendedores = mapTop(d.topVend, row => ({ supervisor: row.supervisor }));
    const top_clientes = mapTop(d.topCli, row => ({ meses_ativos: parseInt(row.meses_ativos, 10) || 0, categorias: parseInt(row.categorias, 10) || 0 }));
    const top_produtos = mapTop(d.topProd, row => ({ categoria: row.categoria }));

    // Acumula (+=) em vez de atribuir: se duas linhas caírem na mesma chave de dia os
    // valores somam, em vez de uma sobrescrever a outra e sumir com receita.
    const por_dia = {};
    for (const row of d.porDia) {
      const k = isoDay(row.dia);
      const acc = por_dia[k] || (por_dia[k] = [0, 0]);
      acc[0] += num(row.r); acc[1] += num(row.c);
    }
    for (const k in por_dia) { por_dia[k][0] = round2(por_dia[k][0]); por_dia[k][1] = round2(por_dia[k][1]); }
    const por_dia_categoria = {};
    for (const row of d.porDiaCat) {
      const k = isoDay(row.dia);
      const dia = por_dia_categoria[k] || (por_dia_categoria[k] = {});
      const acc = dia[row.categoria] || (dia[row.categoria] = [0, 0]);
      acc[0] += num(row.r); acc[1] += num(row.c);
    }
    for (const k in por_dia_categoria) for (const cat in por_dia_categoria[k]) {
      const a = por_dia_categoria[k][cat]; a[0] = round2(a[0]); a[1] = round2(a[1]);
    }

    // por_mes_* / fumo
    const por_mes_clientes = {}; for (const row of d.porMesCli) por_mes_clientes[String(row.mes)] = parseInt(row.n, 10);
    const por_mes_categoria_clientes = {}; for (const row of d.porMesCatCli) { const m = String(row.mes); (por_mes_categoria_clientes[m] = por_mes_categoria_clientes[m] || {})[row.categoria] = parseInt(row.n, 10); }
    // por_mes_categoria_clientes_cod[mes][categoria] = [códigos de cliente] —
    // o front une (Set) os códigos dos meses do período selecionado, contando
    // cada cliente uma única vez mesmo que ele tenha comprado em vários meses.
    const por_mes_categoria_clientes_cod = {};
    for (const row of d.porMesCatCliCod || []) {
      const m = String(row.mes);
      (por_mes_categoria_clientes_cod[m] = por_mes_categoria_clientes_cod[m] || {})[row.categoria] = (row.codigos || []).map(c => String(c));
    }
    const por_mes_fumokg = {}; for (const row of d.porMesFumo) por_mes_fumokg[String(row.mes)] = round2(num(row.kg));
    // total de fumo sem a restrição de meta (por_mes_fumokg é o comparável à meta)
    const por_mes_fumokg_total = {}; for (const row of (d.porMesFumoTotal||[])) por_mes_fumokg_total[String(row.mes)] = round2(num(row.kg));
    const dictKg = rows => { const o = {}; for (const row of rows) if (row.k) o[row.k] = round2(num(row.kg)); return o; };
    const realizado_fumokg = { por_gerente: dictKg(d.realFumoGer), por_supervisor: dictKg(d.realFumoSup), por_vendedor: dictKg(d.realFumoVend) };

    const full_vendedores = {};
    for (const row of d.fullVend) { if (!row.nome) continue; const r = num(row.r), c = num(row.c); full_vendedores[row.nome] = { codigo: row.codigo!=null?String(row.codigo):null, r: round2(r), c: round2(c), q: round2(num(row.qq)), m: margem(r, c), rp: round2(num(row.rp)), rkg: round2(num(row.rkg)), rest: round2(num(row.rest)), supervisor: row.supervisor }; }

    // realizado_por_mes[mes][nivel][nome] = {r,c,rp,rkg,rest} — mesma forma de
    // meta.por_mes, para comparar Meta x Realizado do mês selecionado (não do
    // semestre inteiro) quando há filtro de Gerente/Supervisor/Vendedor.
    const realizado_por_mes = {};
    const addRPM = (nivel, nome, mes, row) => {
      if (!nome) return;
      const m = String(mes);
      const noMes = realizado_por_mes[m] || (realizado_por_mes[m] = { gerente: {}, supervisor: {}, vendedor: {} });
      const r = num(row.r), c = num(row.c);
      noMes[nivel][nome] = { r: round2(r), c: round2(c), rp: round2(num(row.rp)), rkg: round2(num(row.rkg)), rest: round2(num(row.rest)) };
    };
    for (const row of d.porGerMes) addRPM('gerente', row.gerente, row.mes, row);
    for (const row of d.porSupMes) addRPM('supervisor', row.supervisor, row.mes, row);
    for (const row of d.porVendMes) addRPM('vendedor', row.nome, row.mes, row);

    const linhas = parseInt(d.resumo.linhas, 10);
    const qualidade = {
      linhas_sem_cliente: parseInt(d.qual.sem_cli, 10), linhas_sem_produto: parseInt(d.qual.sem_prod, 10),
      linhas_sem_vendedor: parseInt(d.qual.sem_vend, 10), linhas_receita_zero_ou_negativa: parseInt(d.qual.rec_zero, 10),
      linhas_qtde_zero_ou_negativa: parseInt(d.qual.qtd_zero, 10), linhas_custo_maior_que_receita: parseInt(d.qual.custo_maior, 10),
    };

    const mapCash = (rows, extra) => rows.map(row => { const r = num(row.r), c = num(row.c); return Object.assign({ codigo: String(row.codigo), nome: row.nome, r: round2(r), c: round2(c), cash_margin: round2(r - c), m: margem(r, c) }, extra ? extra(row) : {}); });
    const top_clientes_cash = mapCash(d.topCliCash);
    const top_produtos_cash = mapCash(d.topProdCash, row => ({ categoria: row.categoria, q: round2(num(row.qq)) }));
    const top_vendedores_cash = mapCash(d.topVendCash, row => ({ supervisor: row.supervisor }));
    // Top 50 por Margem % (razão) — ranking separado do Top 50 por Cash Margem (R$).
    const top_clientes_margem = mapCash(d.topCliMargem);
    const top_produtos_margem = mapCash(d.topProdMargem, row => ({ categoria: row.categoria, q: round2(num(row.qq)) }));
    const top_vendedores_margem = mapCash(d.topVendMargem, row => ({ supervisor: row.supervisor }));

    // top_clientes_cash_detalhe[codcli] = { categorias:{cat:{r,c}}, vendedor:{codigo,nome,supervisor} }
    // — cascata da aba Cash Margem (Top 50 Clientes): só cobre os 50 clientes de
    // top_clientes_cash (company-wide); sob filtro de Gerente/Supervisor/Vendedor a
    // lista de clientes vem de outra fonte (hier_top_clientes) e pode não ter detalhe.
    const top_clientes_cash_detalhe = {};
    for (const row of d.topCliCashCat || []) {
      const k = String(row.codigo);
      const entry = top_clientes_cash_detalhe[k] || (top_clientes_cash_detalhe[k] = { categorias: {}, vendedor: null });
      entry.categorias[row.categoria] = { r: round2(num(row.r)), c: round2(num(row.c)) };
    }
    const vendCliSeen = new Set();
    for (const row of d.topCliCashVend || []) {
      const k = String(row.codigo);
      if (vendCliSeen.has(k)) continue; // já veio ORDER BY CodCli, receita DESC — 1ª linha = vendedor dominante
      vendCliSeen.add(k);
      const entry = top_clientes_cash_detalhe[k] || (top_clientes_cash_detalhe[k] = { categorias: {}, vendedor: null });
      entry.vendedor = { codigo: String(row.vcodigo), nome: row.vnome, supervisor: row.supervisor };
    }

    // Mesma cascata, para os clientes do Top 50 por MARGEM % (codcli diferentes
    // dos de top_clientes_cash_detalhe acima).
    const top_clientes_margem_detalhe = {};
    for (const row of d.topCliMargemCat || []) {
      const k = String(row.codigo);
      const entry = top_clientes_margem_detalhe[k] || (top_clientes_margem_detalhe[k] = { categorias: {}, vendedor: null });
      entry.categorias[row.categoria] = { r: round2(num(row.r)), c: round2(num(row.c)) };
    }
    const vendCliMargemSeen = new Set();
    for (const row of d.topCliMargemVend || []) {
      const k = String(row.codigo);
      if (vendCliMargemSeen.has(k)) continue;
      vendCliMargemSeen.add(k);
      const entry = top_clientes_margem_detalhe[k] || (top_clientes_margem_detalhe[k] = { categorias: {}, vendedor: null });
      entry.vendedor = { codigo: String(row.vcodigo), nome: row.vnome, supervisor: row.supervisor };
    }

    // ── Top 50 Cliente/Produto POR MÊS + cascata mensal + ano anterior ─────
    // groupByMes: agrupa linhas (que já têm campo mes) num dict {mes: [linhas]}.
    const groupByMes = (rows, mapFn) => {
      const byMes = {};
      (rows || []).forEach(row => { const m = String(row.mes); (byMes[m] = byMes[m] || []).push(row); });
      const out = {};
      for (const m in byMes) out[m] = mapFn(byMes[m]);
      return out;
    };
    const top_clientes_cash_por_mes = groupByMes(d.cliCashPorMes, rows => mapCash(rows));
    const top_clientes_margem_por_mes = groupByMes(d.cliMargemPorMes, rows => mapCash(rows));
    const top_produtos_cash_por_mes = groupByMes(d.prodCashPorMes, rows => mapCash(rows, row => ({ categoria: row.categoria, q: round2(num(row.qq)) })));
    const top_produtos_margem_por_mes = groupByMes(d.prodMargemPorMes, rows => mapCash(rows, row => ({ categoria: row.categoria, q: round2(num(row.qq)) })));

    // top_clientes_detalhe_por_mes[mes][codcli] = { categorias:{cat:{r,c}}, vendedor:{...} }
    // — cobre todo cliente que apareceu em QUALQUER Top 50 (semestre ou mês, Cash
    // ou Margem); por isso a cascata nunca fica sem detalhe por causa do filtro
    // de Mês (é a mesma fonte usada tanto com filtro quanto sem).
    const top_clientes_detalhe_por_mes = {};
    for (const row of d.cliCatPorMes || []) {
      const m = String(row.mes), k = String(row.codigo);
      const porMes = top_clientes_detalhe_por_mes[m] || (top_clientes_detalhe_por_mes[m] = {});
      const entry = porMes[k] || (porMes[k] = { categorias: {}, vendedor: null });
      entry.categorias[row.categoria] = { r: round2(num(row.r)), c: round2(num(row.c)) };
    }
    const vendCliMesSeen = new Set();
    for (const row of d.cliVendPorMes || []) {
      const m = String(row.mes), k = String(row.codigo), seenKey = m + '|' + k;
      if (vendCliMesSeen.has(seenKey)) continue; // ORDER BY CodCli, Mes, receita DESC — 1ª linha = vendedor dominante
      vendCliMesSeen.add(seenKey);
      const porMes = top_clientes_detalhe_por_mes[m] || (top_clientes_detalhe_por_mes[m] = {});
      const entry = porMes[k] || (porMes[k] = { categorias: {}, vendedor: null });
      entry.vendedor = { codigo: String(row.vcodigo), nome: row.vnome, supervisor: row.supervisor };
    }

    // top_clientes_categoria_ano_anterior[codcli][mes][categoria] = {r,c} — MESMO
    // cliente, ano-1, mesmo intervalo de datas (via BASE_CTE). O front soma os
    // meses que precisar (1 mês ou o semestre inteiro) para o comparativo — não
    // depende do cliente TAMBÉM estar no Top 50 do ano passado (raro).
    const top_clientes_categoria_ano_anterior = {};
    for (const row of d.cliCatPorMesAnoAnterior || []) {
      const k = String(row.codigo), m = String(row.mes);
      const porCli = top_clientes_categoria_ano_anterior[k] || (top_clientes_categoria_ano_anterior[k] = {});
      const porMes = porCli[m] || (porCli[m] = {});
      porMes[row.categoria] = { r: round2(num(row.r)), c: round2(num(row.c)) };
    }

    const pagamento_por_categoria = buildPag(d.pag);
    const hier_pagamento_por_categoria = {}; for (const lvl of Object.keys(d.hierPag)) hier_pagamento_por_categoria[lvl] = buildPagHier(d.hierPag[lvl]);

    const janela90 = { inicio: d.janRange && d.janRange.ini ? isoDay(d.janRange.ini) : null, fim: d.janRange && d.janRange.fim ? isoDay(d.janRange.fim) : null };
    const por_produto_janela90 = {}; for (const row of d.janProd) por_produto_janela90[String(row.codigo)] = { r: round2(num(row.r)), c: round2(num(row.c)), q: round2(num(row.qq)) };

    // ── ABCD global (mediana de receita e de margem entre clientes com r>0) ──
    const abcd = buildAbcd(d.abcdCli);
    const medR = abcd.mediana_receita, medM = abcd.mediana_margem;

    // hier_* montados
    const hier_top_clientes = buildHierTop(d.hierTopCli);
    const hier_top_produtos = buildHierTop(d.hierTopProd, true);
    const hier_por_categoria = buildHierCat(d.hierCat);
    const hier_abcd = {}; for (const lvl of Object.keys(d.hierAbcdRows)) hier_abcd[lvl] = buildHierAbcd(d.hierAbcdRows[lvl], medR, medM);
    const hier_por_dia = { gerente: buildDiaByEnt(d.hierDiaGer) };
    const hier_por_dia_categoria = { gerente: buildDiaCatByEnt(d.hierDiaCatGer) };

    return {
      label: periodo.label, linhas,
      receita: round2(receita), custo: round2(custo), qtde: round2(num(d.resumo.qtde)), peso: round2(num(d.resumo.peso)),
      margem_geral: margem(receita, custo),
      n_cli: parseInt(d.resumo.n_cli, 10), n_vend: parseInt(d.resumo.n_vend, 10), n_sup: parseInt(d.resumo.n_sup, 10),
      n_ger: parseInt(d.resumo.n_ger, 10), n_prod: parseInt(d.resumo.n_prod, 10), n_cat: parseInt(d.resumo.n_cat, 10),
      n_grp: parseInt(d.resumo.n_grp, 10), n_pedidos: nPedidos, ticket_pedido: nPedidos > 0 ? round2(receita / nPedidos) : 0,
      por_mes, por_gerente, por_supervisor, por_categoria, por_grupo,
      top_vendedores, top_clientes, top_produtos, por_dia, por_dia_categoria,
      por_mes_clientes, por_mes_categoria_clientes, por_mes_categoria_clientes_cod, por_mes_fumokg, por_mes_fumokg_total, realizado_fumokg, full_vendedores, realizado_por_mes, qualidade,
      top_clientes_cash, top_clientes_cash_detalhe, top_produtos_cash, top_vendedores_cash,
      top_clientes_margem, top_clientes_margem_detalhe, top_produtos_margem, top_vendedores_margem,
      top_clientes_cash_por_mes, top_clientes_margem_por_mes, top_produtos_cash_por_mes, top_produtos_margem_por_mes,
      top_clientes_detalhe_por_mes, top_clientes_categoria_ano_anterior,
      pagamento_por_categoria, hier_pagamento_por_categoria,
      janela90, por_produto_janela90, abcd,
      hier_top_clientes, hier_top_produtos, hier_por_categoria, hier_abcd, hier_por_dia, hier_por_dia_categoria,
      cascata: buildCascata(d.cascCat, d.cascGrp, d.cascForn, d.cascProd),
      meta: d.meta,
      por_canal: (() => { const o = {}; for (const r of d.porCanal || []) o[r.canal_vendas] = { r: round2(num(r.r)), c: round2(num(r.c)), q: round2(num(r.qq)), m: margem(num(r.r), num(r.c)), n_clientes: parseInt(r.n_clientes, 10) }; return o; })(),
      por_inadimplente: (() => { const o = {}; for (const r of d.porInadimplente || []) o[r.inadimplente] = { r: round2(num(r.r)), c: round2(num(r.c)), q: round2(num(r.qq)), m: margem(num(r.r), num(r.c)), n_clientes: parseInt(r.n_clientes, 10) }; return o; })(),
      por_status: (() => { const o = {}; for (const r of d.porStatus || []) o[r.status_cliente] = { r: round2(num(r.r)), c: round2(num(r.c)), q: round2(num(r.qq)), m: margem(num(r.r), num(r.c)), n_clientes: parseInt(r.n_clientes, 10) }; return o; })(),
    };
  }

  // Estoque "box vendedor" — fotografia do último dia disponível (não por período)
  // × venda média diária dos ÚLTIMOS 90 DIAS CORRIDOS REAIS (sempre até hoje,
  // independente do período selecionado no filtro — estoque físico só existe
  // "agora"). Média diária = valor vendido nesses 90 dias ÷ DIAS ÚTEIS reais do
  // calendário (cifalcomercial.tcperiodo, considera feriado nacional — antes o
  // front dividia por 90 fixo, dias corridos). Cruzado por (codven,codproduto),
  // não por produto isolado: cada Gerente/Supervisor/Vendedor usa o RITMO DE
  // VENDA DELE MESMO, não uma média da empresa inteira (senão o "dias de
  // estoque" de um vendedor lento apareceria bom só por causa da empresa).
  async _buildEstoque() {
    const hoje = new Date();
    const iniJanela = new Date(hoje); iniJanela.setDate(iniJanela.getDate() - 89);
    const fmt = dt => dt.toISOString().slice(0, 10);
    const [iniStr, fimStr] = [fmt(iniJanela), fmt(hoje)];

    const rows = (await db.query(`
      WITH latest AS (SELECT MAX(data) d FROM cifalcomercial.posicao_estoque_diario_vendedor)
      SELECT v.codven, v.codproduto, v.saldoestoque saldo, ROUND(v.saldoestoque*p.customedio,2) valor_carga,
             p.desceq descricao, c.descategoriaprod categoria, gp.descricao grupo,
             e.nomven vendedor, s.nomesupervisor supervisor, g.nomegerente gerente
      FROM cifalcomercial.posicao_estoque_diario_vendedor v
      JOIN cifalcomercial.produtos p ON p.codproduto=v.codproduto
      LEFT JOIN cifalcomercial.subgrupos sg ON sg.codsubgrupo=p.codsubgrupo
      LEFT JOIN cifalcomercial.categoriasproduto c ON c.codcategoriaprod=sg.codcategoriaprod
      LEFT JOIN cifalcomercial.grupoprodutos gp ON gp.codgrupo=p.codgrupo
      JOIN cifalcomercial.eqvend e ON e.codven=v.codven
      LEFT JOIN cifalcomercial.supervisor s ON s.codsupervisor=e.codsupervisor
      LEFT JOIN cifalcomercial.gerente g ON g.codgerente=e.codgerente
      JOIN latest ON v.data=latest.d`)).rows;

    const diasUteis90 = parseInt((await db.query(`
      SELECT COUNT(*) n FROM cifalcomercial.tcperiodo
      WHERE final_de_semana=0 AND feriado_nacional=0 AND dia_completo BETWEEN $1 AND $2
    `, [iniStr, fimStr])).rows[0].n, 10);

    const venda90Rows = (await db.query(`
      SELECT codven, codigo codproduto, SUM(total) r, SUM(qtde) qq
      FROM (${BASE_CTE}) s
      GROUP BY codven, codigo
    `, [iniStr, fimStr])).rows;
    const venda90 = {}; // "codven|codproduto" -> {r, q}
    for (const row of venda90Rows) venda90[`${row.codven}|${row.codproduto}`] = { r: num(row.r), q: num(row.qq) };

    const detalhe = [], vendedor_info = {}, por_vendedor = {}, por_supervisor = {}, por_gerente = {}, por_categoria = {}, por_produto = {};
    const prodVend = {}; let comSaldo = 0;
    for (const r of rows) {
      const saldo = num(r.saldo), valor = num(r.valor_carga);
      const v90 = venda90[`${r.codven}|${r.codproduto}`] || { r: 0, q: 0 };
      detalhe.push([String(r.codven), String(r.codproduto), saldo, valor, round2(v90.r), round2(v90.q)]);
      if (saldo > 0) comSaldo++;
      vendedor_info[String(r.codven)] = { vendedor: r.vendedor, supervisor: r.supervisor, gerente: r.gerente };
      const acc = (o, k, extra) => { if (!o[k]) o[k] = Object.assign({ saldo: 0, valor_carga: 0, venda90: 0 }, extra || {}); o[k].saldo += saldo; o[k].valor_carga += valor; o[k].venda90 += v90.r; };
      if (r.vendedor) acc(por_vendedor, r.vendedor, { supervisor: r.supervisor, gerente: r.gerente });
      if (r.supervisor) acc(por_supervisor, r.supervisor, { gerente: r.gerente });
      if (r.gerente) acc(por_gerente, r.gerente);
      if (r.categoria) acc(por_categoria, r.categoria);
      const pk = String(r.codproduto);
      if (!por_produto[pk]) { por_produto[pk] = { saldo: 0, valor_carga: 0, venda90: 0, descricao: r.descricao, categoria: r.categoria, grupo: r.grupo, n_vendedores: 0 }; prodVend[pk] = new Set(); }
      por_produto[pk].saldo += saldo; por_produto[pk].valor_carga += valor; por_produto[pk].venda90 += v90.r;
      if (saldo > 0) prodVend[pk].add(r.codven);
    }
    const rnd = o => { for (const k in o) { o[k].saldo = round2(o[k].saldo); o[k].valor_carga = round2(o[k].valor_carga); o[k].venda90 = round2(o[k].venda90); } };
    rnd(por_vendedor); rnd(por_supervisor); rnd(por_gerente); rnd(por_categoria);
    for (const k in por_produto) { por_produto[k].saldo = round2(por_produto[k].saldo); por_produto[k].valor_carga = round2(por_produto[k].valor_carga); por_produto[k].venda90 = round2(por_produto[k].venda90); por_produto[k].n_vendedores = prodVend[k].size; }
    return {
      linhas: rows.length, linhas_com_saldo: comSaldo, vendedor_info, por_vendedor, por_supervisor, por_gerente, por_categoria, por_produto, detalhe,
      dias_uteis_90: diasUteis90, janela_venda_90: { inicio: iniStr, fim: fimStr },
    };
  }

  // Árvore REAL da força de vendas (cadastro: supervisor + eqvend, só ativos).
  async _hierarquiaReal() {
    const sql = `
      SELECT jsonb_build_object('gerentes', jsonb_agg(gerente_tree)) AS resultado_api
      FROM (
        SELECT s.codgerente, g.nomegerente,
          jsonb_build_object('codgerente', s.codgerente, 'nomegerente', g.nomegerente, 'supervisores', jsonb_agg(
            jsonb_build_object('codsupervisor', s.codsupervisor, 'nomesupervisor', s.nomesupervisor,
              'cpfsup', s.cpfsup, 'vendedores', COALESCE(v.vendedores_list, '[]'::jsonb)))) AS gerente_tree
        FROM cifalcomercial.supervisor s
        LEFT JOIN cifalcomercial.gerente g ON s.codgerente = g.codgerente
        LEFT JOIN (
          SELECT codsupervisor, jsonb_agg(jsonb_build_object('codven', codven, 'nomven', nomven,
            'apelido', apelido, 'email', email, 'celven', celven, 'ativo', ativo)) AS vendedores_list
          FROM cifalcomercial.eqvend
          WHERE codsupervisor IS NOT NULL AND (ativo='S' OR ativo='Sim' OR ativo='1' OR ativo='true')
          GROUP BY codsupervisor) v ON s.codsupervisor = v.codsupervisor
        WHERE (s.sup_inativo IS NULL OR s.sup_inativo='N' OR s.sup_inativo='0' OR s.sup_inativo='false')
        GROUP BY s.codgerente, g.nomegerente) t;`;
    const r = await db.query(sql);
    const data = (r.rows[0] && r.rows[0].resultado_api) || { gerentes: [] };
    
    // Não precisa formatar (já vêm formatados no banco)
    return data;
  }

  async run() {
    const resultado = {};
    for (const periodo of PERIODOS) resultado[periodo.key] = await this._buildPeriodo(periodo);
    try { resultado._estoque = await this._buildEstoque(); } catch (e) { console.error('[ETL] estoque falhou:', e.message); }
    try { resultado._hierarquia = await this._hierarquiaReal(); } catch (e) { console.error('[ETL] hierarquia falhou:', e.message); }
    return resultado;
  }
}

// ── helpers de montagem ──────────────────────────────────────────
function buildPag(rows) {
  const o = {};
  for (const r of rows) { const cat = r.categoria; ((o[cat] = o[cat] || {})[r.tipo] = (o[cat][r.tipo] || {}))[r.tipocob] = round2(num(r.v)); }
  return o;
}
function buildPagHier(rows) {
  const o = {};
  for (const r of rows) { const e = r.ent; if (!e) continue; const cat = ((o[e] = o[e] || {})[r.categoria] = o[e][r.categoria] || {}); (cat[r.tipo] = cat[r.tipo] || {})[r.tipocob] = round2(num(r.v)); }
  return o;
}
function buildHierTop(byLevel, isProd) {
  const out = {};
  for (const lvl of Object.keys(byLevel)) {
    const o = {};
    for (const r of byLevel[lvl]) {
      if (!r.ent) continue;
      const rr = num(r.r), cc = num(r.c);
      const item = { codigo: String(r.codigo), nome: r.nome, r: round2(rr), c: round2(cc), q: round2(num(r.qq)), m: margem(rr, cc) };
      if (isProd) item.categoria = r.categoria;
      (o[r.ent] = o[r.ent] || []).push(item);
    }
    out[lvl] = o;
  }
  return out;
}
function buildHierCat(byLevel) {
  const out = {};
  for (const lvl of Object.keys(byLevel)) {
    const o = {};
    for (const r of byLevel[lvl]) { if (!r.ent) continue; const rr = num(r.r), cc = num(r.c); (o[r.ent] = o[r.ent] || {})[r.categoria] = { r: round2(rr), c: round2(cc), q: round2(num(r.qq)), m: margem(rr, cc) }; }
    out[lvl] = o;
  }
  return out;
}
// Acumulam por dia (mesma razão de por_dia/por_dia_categoria: nunca sobrescrever).
function buildDiaByEnt(rows) {
  const o = {};
  for (const r of rows) {
    if (!r.ent) continue;
    const ent = o[r.ent] || (o[r.ent] = {});
    const k = isoDay(r.dia);
    const acc = ent[k] || (ent[k] = [0, 0]);
    acc[0] += num(r.r); acc[1] += num(r.c);
  }
  for (const e in o) for (const k in o[e]) { o[e][k][0] = round2(o[e][k][0]); o[e][k][1] = round2(o[e][k][1]); }
  return o;
}
function buildDiaCatByEnt(rows) {
  const o = {};
  for (const r of rows) {
    if (!r.ent) continue;
    const ent = o[r.ent] || (o[r.ent] = {});
    const k = isoDay(r.dia);
    const dia = ent[k] || (ent[k] = {});
    const acc = dia[r.categoria] || (dia[r.categoria] = [0, 0]);
    acc[0] += num(r.r); acc[1] += num(r.c);
  }
  for (const e in o) for (const k in o[e]) for (const cat in o[e][k]) {
    const a = o[e][k][cat]; a[0] = round2(a[0]); a[1] = round2(a[1]);
  }
  return o;
}
// Cascata: Categoria → Grupo → Fornecedor → Produto. n_cli/n_grp/n_for/n_prod são
// os DISTINTOS reais por nível (das queries próprias). Limites: top 20 fornecedores
// por grupo, top 8 produtos por fornecedor (por Faturamento) — n_* mostram o total real.
function buildCascata(catRows, grpRows, fornRows, prodRows) {
  const cat = {}; for (const r of catRows) cat[r.categoria] = { r: num(r.r), c: num(r.c), q: num(r.q), p: num(r.p), n_cli: parseInt(r.n_cli, 10), n_grp: parseInt(r.n_grp, 10) };
  const grp = {}; for (const r of grpRows) ((grp[r.categoria] = grp[r.categoria] || {})[r.grupo] = { r: num(r.r), c: num(r.c), q: num(r.q), p: num(r.p), n_cli: parseInt(r.n_cli, 10), n_for: parseInt(r.n_for, 10) });
  const forn = {}; for (const r of fornRows) { const g = ((forn[r.categoria] = forn[r.categoria] || {})[r.grupo] = forn[r.categoria][r.grupo] || {}); g[r.fornecedor] = { r: num(r.r), c: num(r.c), q: num(r.q), p: num(r.p), n_cli: parseInt(r.n_cli, 10), n_prod: parseInt(r.n_prod, 10) }; }
  const prod = {}; for (const r of prodRows) { const f = (((prod[r.categoria] = prod[r.categoria] || {})[r.grupo] = prod[r.categoria][r.grupo] || {})[r.fornecedor] = prod[r.categoria][r.grupo][r.fornecedor] || []); f.push({ nome: r.produto, r: num(r.r), c: num(r.c), q: num(r.q), p: num(r.p), n_cli: parseInt(r.n_cli, 10) }); }

  const out = {};
  for (const cn of Object.keys(cat)) {
    const cnode = cat[cn]; const grupos = {};
    for (const gn of Object.keys((grp[cn] || {}))) {
      const gnode = grp[cn][gn]; const fornecedores = {};
      const fList = Object.keys((forn[cn] && forn[cn][gn]) || {}).map(fn => [fn, forn[cn][gn][fn]]).sort((a, b) => b[1].r - a[1].r).slice(0, 20);
      for (const [fn, fnode] of fList) {
        const pList = (((prod[cn] || {})[gn] || {})[fn] || []).slice().sort((a, b) => b.r - a.r).slice(0, 8);
        const produtos = {};
        for (const pr of pList) produtos[pr.nome] = [round2(pr.r), round2(pr.c), round2(pr.q), round2(pr.p), pr.n_cli];
        fornecedores[fn] = [round2(fnode.r), round2(fnode.c), round2(fnode.q), round2(fnode.p), margem(fnode.r, fnode.c), fnode.n_cli, fnode.n_prod, produtos];
      }
      grupos[gn] = { r: round2(gnode.r), c: round2(gnode.c), q: round2(gnode.q), p: round2(gnode.p), m: margem(gnode.r, gnode.c), n_cli: gnode.n_cli, n_for: gnode.n_for, fornecedores };
    }
    out[cn] = { r: round2(cnode.r), c: round2(cnode.c), q: round2(cnode.q), p: round2(cnode.p), m: margem(cnode.r, cnode.c), n_cli: cnode.n_cli, n_grp: cnode.n_grp, grupos };
  }
  return out;
}
function median(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function classifyAbcd(r, m, medR, medM) { return (r >= medR && m >= medM) ? 'A' : (r >= medR) ? 'B' : (m >= medM) ? 'C' : 'D'; }
function buildAbcd(cliRows) {
  const clientes = cliRows.map(x => { const r = num(x.r), c = num(x.c); return { nome: x.nome, r, c, m: r > 0 ? 100 * (1 - c / r) : 0 }; }).filter(x => x.r > 0);
  const medR = median(clientes.map(x => x.r));
  const medM = median(clientes.map(x => x.m));
  const q = {}; for (const k of ['A', 'B', 'C', 'D']) q[k] = { count: 0, receita: 0, custo: 0, cash_margin: 0, exemplos: [] };
  for (const cl of clientes) { const k = classifyAbcd(cl.r, cl.m, medR, medM); q[k].count++; q[k].receita += cl.r; q[k].custo += cl.c; }
  for (const k of ['A', 'B', 'C', 'D']) {
    q[k].receita = round2(q[k].receita); q[k].custo = round2(q[k].custo); q[k].cash_margin = round2(q[k].receita - q[k].custo);
    q[k].exemplos = clientes.filter(cl => classifyAbcd(cl.r, cl.m, medR, medM) === k).sort((a, b) => b.r - a.r).slice(0, 50)
      .map(cl => ({ nome: cl.nome, r: round2(cl.r), c: round2(cl.c), m: round2(cl.m) }));
  }
  return Object.assign(q, { mediana_receita: round2(medR), mediana_margem: round2(medM), n_clientes_considerados: clientes.length });
}
function buildHierAbcd(entRows, medR, medM) {
  // entRows: linhas (ent, r, c) já a nível de cliente dentro da entidade — classifica pela mediana GLOBAL.
  const o = {};
  for (const row of entRows) {
    if (!row.ent) continue;
    const r = num(row.r), c = num(row.c); if (r <= 0) continue;
    const m = 100 * (1 - c / r);
    const k = classifyAbcd(r, m, medR, medM);
    const e = o[row.ent] = o[row.ent] || { A: z(), B: z(), C: z(), D: z() };
    e[k].count++; e[k].receita += r; e[k].custo += c;
  }
  for (const ent in o) for (const k of ['A', 'B', 'C', 'D']) { o[ent][k].receita = round2(o[ent][k].receita); o[ent][k].custo = round2(o[ent][k].custo); o[ent][k].cash_margin = round2(o[ent][k].receita - o[ent][k].custo); }
  return o;
  function z() { return { count: 0, receita: 0, custo: 0, cash_margin: 0 }; }
}

module.exports = new DashboardETLService();
// Reaproveitados pelas consultas sob demanda (recorte por cliente / por filtros),
// que rodam o mesmo BASE_CTE com WHERE dinâmico — números batem com o cubo.
// Os builders são compartilhados para o recorte produzir EXATAMENTE as mesmas
// formas do cubo (o front troca uma pela outra sem saber a origem).
module.exports.BASE_CTE = BASE_CTE;
module.exports.PERIODOS = PERIODOS;
module.exports.buildAbcd = buildAbcd;
module.exports.buildCascata = buildCascata;
module.exports.isoDay = isoDay;

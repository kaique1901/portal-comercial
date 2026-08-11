const db = require('../config/db');

class DashboardRepository {
  // A query base mapeada do Excel (Common Table Expression)
  getBaseQueryCTE() {
    return `
      WITH base_vendas AS (
        select 
          s.*,
          subgrupos.codcategoriaprod as codcateg,
          categoriasproduto.descategoriaprod as categoria,
          Produtos.CodFor,
          EQFORD.Razfor As Fornecedor,
          Produtos.CodSubGrupo AS CodGru,
          SubGrupos.DesSubGrupo AS Grupo,
          Produtos.Desceq AS Descricao,
          1 - s.customedio / nullif(s.total,0) as margem
        from(
          select 
            supervisor.nomesupervisor as supervisor,
            supervisor.codgerente as codger,
            gerente.nomegerente as gerente, 
            Gerente.Token AS GToken,
            Supervisor.token AS SToken,
            extract (month from Pedidos.DataFechamento) AS Mes,
            case when Pedidos.CodTipoCob=1 then 'VISTA' 
                 when Pedidos.CodTipoCob=2 then 'CHEQUE' 
                 when Pedidos.CodTipoCob=3 then 'BOLETO' 
                 when Pedidos.CodTipoCob=4 then 'CARTEIRA' else '' end AS Cob,
            Pedidos.DataFechamento AS DataPed,
            Pedidos.CodCliente AS CodCli,
            EQCLID.NOMCLI AS Cliente,
            EQCLID.ENDCLI||' -N.'||EQCLID.NroEnd AS Endereco,
            EQCLID.ENDCLI AS Bairro,
            Cidades.NomCid AS Cidade,
            Cidades.EstCid AS UF,
            Atividades.DesAti AS Atividade,
            Pedidos.NroPedido AS NroPed, 
            eqvend.Codsupervisor AS CodSup,
            Pedidos.CodVendedor AS CodVen,
            EQVEND.NOMVEN AS Vendedor,
            ItensPedido.CodProduto AS Codigo,
            (Case When coalesce(TotDescontoNota,0) > 0 then (ItensPedido.Qtde*ItensPedido.ValUni) * (1 - (TotDescontoNota/TotProdutos)) Else (ItensPedido.Qtde*ItensPedido.ValUni) End) AS Total,
            upadrao.unidade AS Unid,
            (ItensPedido.Qtde * UnidadeAlt.QdeEmb)/upadrao.qdeemb AS Qtde,
            ItensPedido.Qtde*UnidadeAlt.PesoLiq AS Peso,
            itenspedido.qtde * itenspedido.customedio as customedio,
            case when pedidos.valdinheiro>0 then 'DINHEIRO' 
                 when pedidos.valcheque>0 then 'CHEQUE'  
                 when pedidos.valdup>0 then 'BOLETO' 
                 when pedidos.valorpix>0 then 'PIX' else 'OUTROS' end as TipoCob,
            pedidos.pednegociacao,
            pedidos.pednegociacaovol,
            case when pedidos.codempresa = 501 and coalesce(pedidos.tipoempresa,0) in(0,501) then 'Cupom' else 'Danfe' end as tipo
          from cifalcomercial.Pedidos  
          join cifalcomercial.ItensPedido on ItensPedido.NroPedido=Pedidos.NroPedido
          join cifalcomercial.UnidadeAlt on ItensPedido.CodProduto=UnidadeAlt.CodProduto and ItensPedido.Unidade=UnidadeAlt.Unidade
          left join cifalcomercial.unidadealt upadrao on upadrao.codproduto = itenspedido.codproduto and upadrao.unidpadrao ilike 's'
          join cifalcomercial.Eqvend on pedidos.codvendedor=eqvend.codven
          join cifalcomercial.EQCLID on Pedidos.CodCliente=EQCLID.CODCLI
          left join cifalcomercial.Atividades on EQCLID.CodAti=Atividades.CodAti
          join cifalcomercial.Supervisor on Supervisor.CodSupervisor=eqvend.CodSupervisor
          join cifalcomercial.Cidades on EQCLID.CODCID=Cidades.CodCid
          join cifalcomercial.Gerente on Supervisor.CodGerente=Gerente.CodGerente	
          where Pedidos.Cancelado is null 
          and Pedidos.CodTpo in(2,4,5) 
          and pedidos.datafechamento::date >= $1
          and pedidos.datafechamento::date <= $2
        ) as s
        join cifalcomercial.Produtos on s.codigo=Produtos.CodProduto
        join cifalcomercial.SubGrupos on Produtos.CodSubGrupo=SubGrupos.CodSubGrupo
        join cifalcomercial.EQFORD on Produtos.CodFor=EQFORD.Codfor
        left join cifalcomercial.categoriasproduto on categoriasproduto.codcategoriaprod=subgrupos.codcategoriaprod
      )
    `;
  }

  async getResumo(dataInicial, dataFinal) {
    const query = `
      ${this.getBaseQueryCTE()}
      SELECT 
        SUM(Total) as receita,
        SUM(customedio) as custo,
        SUM(Qtde) as qtde,
        SUM(Peso) as peso,
        COUNT(DISTINCT CodCli) as n_cli,
        COUNT(DISTINCT CodVen) as n_vend,
        COUNT(DISTINCT CodSup) as n_sup,
        COUNT(DISTINCT codger) as n_ger,
        COUNT(DISTINCT Codigo) as n_prod,
        COUNT(DISTINCT codcateg) as n_cat,
        COUNT(DISTINCT CodGru) as n_grp,
        COUNT(DISTINCT NroPed) as n_pedidos
      FROM base_vendas;
    `;
    const result = await db.query(query, [dataInicial, dataFinal]);
    return result.rows[0];
  }

  async getVendasPorDia(dataInicial, dataFinal) {
    const query = `
      ${this.getBaseQueryCTE()}
      SELECT 
        DataPed as data_venda,
        SUM(Total) as receita,
        SUM(customedio) as custo
      FROM base_vendas
      GROUP BY DataPed
      ORDER BY DataPed;
    `;
    const result = await db.query(query, [dataInicial, dataFinal]);
    return result.rows;
  }

  async getVendasPorCategoria(dataInicial, dataFinal) {
    const query = `
      ${this.getBaseQueryCTE()}
      SELECT 
        categoria,
        SUM(Total) as receita,
        SUM(customedio) as custo,
        SUM(Qtde) as qtde,
        SUM(Peso) as peso,
        COUNT(DISTINCT CodCli) as n_clientes
      FROM base_vendas
      WHERE categoria IS NOT NULL
      GROUP BY categoria
      ORDER BY receita DESC;
    `;
    const result = await db.query(query, [dataInicial, dataFinal]);
    return result.rows;
  }

  async getHierarquia(dataInicial, dataFinal) {
    const query = `
      ${this.getBaseQueryCTE()}
      SELECT 
        gerente,
        supervisor,
        SUM(Total) as receita,
        SUM(customedio) as custo
      FROM base_vendas
      GROUP BY gerente, supervisor
      ORDER BY gerente, receita DESC;
    `;
    const result = await db.query(query, [dataInicial, dataFinal]);
    return result.rows;
  }
}

module.exports = new DashboardRepository();

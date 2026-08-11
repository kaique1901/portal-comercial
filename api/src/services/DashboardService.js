const DashboardRepository = require('../repositories/DashboardRepository');

class DashboardService {
  async getResumo(dataInicial, dataFinal) {
    const data = await DashboardRepository.getResumo(dataInicial, dataFinal);
    // Calcular margem: 1 - (custo / receita)
    const receita = parseFloat(data.receita) || 0;
    const custo = parseFloat(data.custo) || 0;
    const margem = receita > 0 ? (1 - (custo / receita)) * 100 : 0;
    
    return {
      ...data,
      margem_geral: parseFloat(margem.toFixed(2))
    };
  }

  async getVendasPorDia(dataInicial, dataFinal) {
    const rows = await DashboardRepository.getVendasPorDia(dataInicial, dataFinal);
    // Formatar no formato esperado pelo dashboard: { "2026-01-02": [receita, custo] }
    const formatado = {};
    for (const row of rows) {
      // row.data_venda pode vir como Date object, formata para YYYY-MM-DD
      const date = new Date(row.data_venda);
      const isoDate = date.toISOString().split('T')[0];
      formatado[isoDate] = [parseFloat(row.receita), parseFloat(row.custo)];
    }
    return formatado;
  }

  async getCategorias(dataInicial, dataFinal) {
    const rows = await DashboardRepository.getVendasPorCategoria(dataInicial, dataFinal);
    // Formatar como: { "CATEGORIA": { r: receita, c: custo, q: qtde, p: peso, n_clientes: n } }
    const formatado = {};
    for (const row of rows) {
      const receita = parseFloat(row.receita) || 0;
      const custo = parseFloat(row.custo) || 0;
      const margem = receita > 0 ? ((1 - (custo / receita)) * 100).toFixed(2) : 0;
      
      formatado[row.categoria] = {
        r: receita,
        c: custo,
        q: parseFloat(row.qtde),
        p: parseFloat(row.peso),
        m: parseFloat(margem),
        n_clientes: parseInt(row.n_clientes, 10)
      };
    }
    return formatado;
  }

  async getHierarquia(dataInicial, dataFinal) {
    const rows = await DashboardRepository.getHierarquia(dataInicial, dataFinal);
    // Formatar por supervisor ou gerente. Exemplo retornando tudo formatado:
    const por_supervisor = {};
    const por_gerente = {};
    
    for (const row of rows) {
      const sup = row.supervisor;
      const ger = row.gerente;
      const receita = parseFloat(row.receita) || 0;
      const custo = parseFloat(row.custo) || 0;
      
      // Agregando supervisor
      if (!por_supervisor[sup]) {
        por_supervisor[sup] = { r: 0, c: 0, gerente: ger };
      }
      por_supervisor[sup].r += receita;
      por_supervisor[sup].c += custo;
      
      // Agregando gerente
      if (!por_gerente[ger]) {
        por_gerente[ger] = { r: 0, c: 0 };
      }
      por_gerente[ger].r += receita;
      por_gerente[ger].c += custo;
    }
    
    // Calcula margens
    for (const key in por_supervisor) {
      const r = por_supervisor[key].r;
      const c = por_supervisor[key].c;
      por_supervisor[key].m = r > 0 ? parseFloat(((1 - (c / r)) * 100).toFixed(2)) : 0;
    }
    for (const key in por_gerente) {
      const r = por_gerente[key].r;
      const c = por_gerente[key].c;
      por_gerente[key].m = r > 0 ? parseFloat(((1 - (c / r)) * 100).toFixed(2)) : 0;
    }
    
    return { por_gerente, por_supervisor };
  }
}

module.exports = new DashboardService();

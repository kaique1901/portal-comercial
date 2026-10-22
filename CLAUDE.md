# Portal Comercial — guia para o Claude Code

## Contexto do projeto

Portal de BI comercial da **Cifal Distribuidora**, usado por Diretoria,
Gerentes, Supervisores e Vendedores para acompanhar resultado de vendas
(receita, margem, metas, positivação, estoque, inadimplência etc.).

- **Público**: Diretoria/Presidência (visão executiva), Gerentes/Supervisores
  (visão por carteira/equipe) e Vendedores (visão individual) — o portal
  respeita essa hierarquia via filtros de Gerente/Supervisor/Vendedor em
  praticamente todas as abas.
- **Segmento**: distribuição (CIFAL DISTRIBUIDORA).
- **Metas de negócio** (margem % mínima, faturamento mensal alvo etc.): não
  estão fixadas aqui de propósito — cada Gerente/categoria tem meta própria
  cadastrada no ERP e já é lida dinamicamente pelo portal (`meta`,
  `meta_valrentabilidade` etc. no cubo de dados). Não cravar números fixos
  neste arquivo; se precisar de um limiar de negócio, pergunte ao usuário ou
  leia do dado real.

## Regra de ouro

**Nunca invente número.** Todo KPI/tabela/gráfico vem de uma consulta real
no cubo de dados (`REAL_DATA`, `/full`, `/recorte`) ou de uma função já
existente que lê esse cubo. Se um dado não existir ou não puder ser
calculado com confiança, mostre uma nota explícita ("sem base", "dado
indisponível") em vez de estimar ou aproximar silenciosamente.

## Antes de alterar qualquer coisa

1. Leia o código relevante antes de mexer — este projeto tem lógica de
   negócio não óbvia (recortes por hierarquia, cubos por semestre,
   convenções de sinal/cor) que não deve ser reinventada.
2. Se a alteração for not-trivial (nova métrica, mudança de cálculo, nova
   aba), **pergunte antes de implementar**: mostre o que vai mudar, por que,
   e o resultado esperado — só depois implemente.
3. Mudanças em uma aba não podem alterar o comportamento de outra aba sem
   avisar. Prefira expor dado novo de forma aditiva (ex.: um `return {...}`
   a mais no fim de uma função) a reescrever lógica existente.
4. Só faça commit/push ("subir para produção") mediante pedido explícito do
   usuário nesta conversa — nunca por conta própria.

## Arquitetura (resumo)

- **Backend** (`api/src/services/DashboardETLService.js`): monta um cubo de
  dados (`REAL_DATA[periodo]`, ex. `'2026_2'`) por semestre a partir de uma
  CTE única (`tmp_base_vendas`). `DashboardRecorteService.js` espelha as
  mesmas consultas filtradas por hierarquia/categoria/cliente sob demanda
  (endpoint `/recorte`), para os filtros do menu lateral.
- **Frontend** (`public/js/app.js`, mais `dashboard.js`, `apresentacao.js`,
  `diario.js` etc.): cada aba tem uma função `renderXxx()` que lê o cubo
  (`curPeriod()`/`mesclarRecorte()` já aplicam o recorte certo) e desenha a
  tela. `apresentacao.js` reaproveita essas mesmas funções (via
  `apexExtractXxx()`) para montar o deck de PPTX/HTML — nunca recalcula
  nada por conta própria.
- **Dados de prazo/pagamento já existem, mas estão subutilizados**:
  `pedidos.prazomedio` é selecionado como `prazo_pagamento` na query base
  (`DashboardETLService.js`) mas hoje não é agregado/exposto em nenhum
  KPI — é uma coluna "dormente". Já existe, por outro caminho, data de
  vencimento real de recebíveis (`cr.datven`), que já alimenta a aba
  **Inadimplência por Carteira**. Ou seja: ao contrário do que se poderia
  supor, o projeto não "não tem" dado de prazo — ele tem parte do dado e
  não usa a outra parte ainda. Se for pedido um KPI de "margem de caixa"
  (ajustada por prazo de recebimento/pagamento), isso é tecnicamente viável
  com os dados existentes — trate como uma feature nova a construir
  (perguntando antes como descrito acima), não como algo bloqueado por
  falta de dado.
- **"Cash Margem" ≠ "margem de caixa"**: no portal, **Cash Margem** é um
  conceito já implementado e usado em várias abas (Dashboard, Margem & Cash
  Margem, Apresentação Executiva) e significa **Receita − Custo** (uma
  margem de contribuição em R$, sem relação com prazo de recebimento). Não
  confundir com "margem de caixa" (ajustada pelo tempo até o recebimento),
  que é o conceito citado no parágrafo anterior. São duas coisas diferentes
  com nomes parecidos — não restrinja nem renomeie o Cash Margem existente
  achando que ele é a mesma coisa.

## Páginas de Dashboard

A aba "DashBoard" é a tela de entrada — uma síntese de nível diretoria que
reaproveita os extractors já existentes (sem recalcular nada). Hoje ela
mostra 6 KPIs-herói (Receita, Margem %, Cash Margem, Ticket Médio, Clientes
Ativos, Vendedores Ativos). Se for pedido reduzir para um número menor de
KPIs no topo, é uma decisão de produto (priorizar quais 3-5 números
importam mais) — pergunte antes de remover algum.

## Padrão de entrega

- Teste local (API + frontend) antes de reportar como pronto; compare
  números novos com os da aba de origem (mesma checagem cruzada já usada
  neste projeto).
- Rode `node --check` em todo arquivo `.js` alterado.
- Reporte o que foi feito, com prints/trechos quando fizer sentido, antes de
  qualquer commit.

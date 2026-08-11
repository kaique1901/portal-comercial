# Portal Comercial Executivo

Portal Comercial: front-end web (Vanilla JS, HTML e CSS) em `public/` que consome **100% dos dados da API** (`api/`), a qual agrega direto do banco PostgreSQL. Sem planilhas Excel, sem arquivos estáticos de dados.

## Estrutura do Projeto

- `public/`: front-end servido ao usuário.
  - `index.html`: Arquivo principal.
  - `css/style.css`: Estilos (tema escuro + claro).
  - `js/app.js`: Lógica do front-end; busca tudo de `GET /api/v1/dashboard/full`.
- `api/`: API Node/Express que agrega os dados do PostgreSQL (ETL em cache).
  - `.env`: credenciais do banco (não versionar).

## Como Executar

Requer [Node.js](https://nodejs.org/) e acesso ao banco PostgreSQL configurado em `api/.env`.

1. **API** (porta 4001): `cd api && npm install && npm start`. No boot ela monta o cache (ETL, ~6-7 min); enquanto isso responde `503` e o front mostra "preparando os dados".
2. **Front-end**: na raiz, `npm start` (serve `public/`). Acesse o link exibido (ex.: `http://localhost:3000`).

## Notas Técnicas

- **Todos** os dados vêm da API (que consulta o banco em tempo real). Não há planilhas nem arquivos estáticos de dados.
- Gráficos com [Chart.js](https://www.chartjs.org/). Tema claro/escuro alternável no topo.

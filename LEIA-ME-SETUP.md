# Portal Comercial Executivo — setup

Pacote sem `node_modules` e sem as bases `.xlsx` grandes (o painel lê do Postgres,
não de planilha).

## 1. Credenciais do banco

O `api/.env` **já vem preenchido** com host, usuário e senha do Postgres, então a API
sobe sem configuração.

> **Este zip contém a senha do banco de produção em texto claro.** Trate o arquivo
> como confidencial: não suba em repositório, não anexe em canal público. Se ele
> circular além do previsto, troque a senha do usuário `plancomercial` e atualize o
> `.env` nos ambientes.

## 2. API

```bash
cd api
npm install
node src/server.js
```

Sobe em `http://localhost:4001`. No boot o ETL monta o cubo lendo o Postgres —
leva **~6 a 8 minutos**. Até terminar, `GET /api/v1/dashboard/full` responde
**503** e o front mostra "Preparando os dados no servidor…". O ciclo se repete a
cada 10 minutos.

## 3. Front

Qualquer servidor de arquivos estáticos sobre `public/`:

```bash
npx serve public -l 3006
```

O front descobre a API por `http://<hostname>:4001` — se a API estiver em outra
máquina/porta, ajuste `window.API_BASE_URL` no topo de `public/js/app.js`.

## 4. Docker (opcional)

```bash
docker compose up -d --build
```

API em `:4001`, front em `:3006`. Atenção: o `public/Dockerfile` **copia** os
arquivos para dentro da imagem, então toda alteração no front exige
`docker compose up -d --build frontend` — recarregar o navegador não basta.

## Arquitetura em 4 linhas

- `api/src/services/DashboardETLService.js` — ETL que monta o cubo (`BASE_CTE` é a
  consulta base de vendas; `PERIODOS` define os semestres materializados).
- `api/src/services/DashboardRecorteService.js` — recorte exato sob demanda
  (`/recorte`), usado quando o cubo não cruza os filtros pedidos. Reaproveita o
  mesmo `BASE_CTE`, então os números batem com o cubo por construção.
- `api/src/jobs/DashboardCacheManager.js` — mantém o cubo em memória e recicla.
- `public/js/app.js` — painel inteiro. `curPeriod()` é o ponto único por onde todas
  as abas leem os dados: quando existe recorte carregado, ele devolve o período já
  filtrado pelo escopo do usuário logado e pelo mês selecionado.

## Pontos de atenção conhecidos

1. **Login com credencial fixa no código.** `public/js/app.js` chama
   `https://apis.cifaldistribuidora.com.br:8001/auth` com `userName`/`password`
   fixos para obter o token, e só depois valida o usuário em
   `/Roteiro/{cargo}/login`. Isso está no JavaScript, ou seja, é visível a
   qualquer pessoa com o navegador aberto. Deveria virar um proxy no backend —
   há um esqueleto em `api/src/routes/authRoutes.js`.

2. **`metacategoria.permargem` com escala inconsistente no ERP.** 2026/07 está
   gravado `0,273` (27,3%) e 2026/08 `0,00273` — 100× menor. O ETL normaliza na
   leitura (`normPermargem`: valores < 0,01 são multiplicados por 100), mas o dado
   de origem continua errado.

3. **`valrentabilidade` zerada desde 2026.** A meta de rentabilidade é calculada
   como `meta de receita × permargem`, validada contra a planilha oficial
   ("Rev Forescast AGO26", incluída em `Bases/`): as 35 células de agosto
   (7 categorias × 5 gerentes) conferem exatamente, total R$ 17.877.925.

4. **O painel é mensal.** O seletor de semestre foi removido da tela; o período
   ainda existe internamente porque o cubo é montado por semestre, mas é derivado
   do mês escolhido. Ao abrir num mês em curso, o realizado é parcial e o painel
   avisa ("mês em curso — X de Y dias").

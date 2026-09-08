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

O front escolhe a URL da API pelo protocolo da página:

- **HTTP** (`npx serve`, ou o container acessado direto por `IP:3006`) →
  `http://<hostname>:4001`.
- **HTTPS** (produção, atrás do proxy da borda) → same-origin `/api/v1/dashboard`,
  atendido pelo proxy do `public/nginx.conf`. Chamar `http://<host>:4001` a partir
  de uma página HTTPS é Mixed Content: o navegador bloqueia antes de a requisição
  sair, e a tela mostra "Failed to fetch".

Para API em outra máquina/porta, defina `window.API_BASE_URL` antes de carregar o
`app.js` — esse valor vence a regra acima.

## 4. Docker (opcional)

O compose **não lê `api/.env`** — esse arquivo está no `.gitignore`, então num clone
do repositório ele não existe e o compose aborta antes de construir qualquer coisa
(`failed to resolve services environment: env file .../api/.env not found`). As
credenciais entram por variável de ambiente, de fora do repositório.

**Local:**

```bash
docker compose --env-file api/.env up -d --build
```

**Portainer (stack a partir do Git):** cadastre em *Environment variables* do stack,
antes de fazer o deploy:

| Variável | Obrigatória | Padrão |
| --- | --- | --- |
| `DB_HOST` | sim | — |
| `DB_USER` | sim | — |
| `DB_PASSWORD` | sim | — |
| `DB_NAME` | sim | — |
| `DB_PORT` | não | `5432` |
| `PORT` | não | `4001` |

Faltando alguma das obrigatórias, o deploy falha na hora com o nome da variável em
vez de subir e morrer depois no timeout de conexão do banco.

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

## Cache do navegador no front (`public/serve.json`)

O `serve` mandava só `ETag`, sem `Cache-Control`. Sem essa diretiva o Chrome aplica
cache heurístico e pode continuar executando o `app.js` antigo depois de um deploy
**sem sequer revalidar** — o sintoma é alguém depurando um bug que já não existe no
código, ou uma funcionalidade nova que "não aparece".

`public/serve.json` passa a mandar `Cache-Control: no-cache` em html/js/css. Isso
não desliga o cache: obriga a revalidar a cada carga. Como o ETag continua valendo,
quando nada mudou a resposta é um `304` vazio; quando mudou, vem o arquivo novo.

Atenção: isso vale para o `npx serve`. **Servindo por Docker/nginx a configuração é
outra** — o `public/Dockerfile` copia os arquivos para dentro da imagem, então além
do cache do navegador é preciso reconstruir a imagem
(`docker compose up -d --build frontend`).

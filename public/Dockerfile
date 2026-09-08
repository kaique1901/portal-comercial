FROM nginx:alpine

# Proxy reverso de /api/ para o container da API (ver nginx.conf). Sem ele o front
# chama http://<host>:4001 direto e, com a pagina servida por HTTPS, o navegador
# bloqueia como Mixed Content antes de a requisicao sair — "Failed to fetch".
#
# nginx.conf NAO pode estar no .dockerignore: arquivo ignorado nao entra no contexto
# de build, e um `COPY nginx.conf` explicito falha com `"/nginx.conf": not found`.
# Por isso aqui se copia o diretorio inteiro e se MOVE o arquivo para a pasta de
# config — de quebra ele sai de dentro do html, entao a config do proxy nao fica
# publicada em /nginx.conf.
COPY . /usr/share/nginx/html
RUN mv /usr/share/nginx/html/nginx.conf /etc/nginx/conf.d/default.conf

# CACHE BUSTING — por que isto e necessario mesmo com o no-cache do nginx.conf:
# a borda (openresty) SOBRESCREVE o Cache-Control de js/css. Medido no host de
# producao, para o MESMO arquivo (etag "6aa01e8a-63737"):
#   pelo IP  ->  Cache-Control: no-cache        (o que o container manda)
#   pelo DNS ->  Cache-Control: max-age=34563   (~9,6h, carimbado pela borda)
# Ou seja, depois de um deploy o navegador seguia executando o app.js antigo por
# horas sem nem revalidar, e a config dessa borda nao esta neste repositorio.
#
# O index.html escapa: chega com no-cache e revalida a cada carga (confirmado).
# Entao a saida e mudar a URL do asset quando o conteudo muda — o hash entra na
# query e, ao ler o HTML novo, o navegador pede uma URL que nunca esteve no cache
# dele. Vale para todo mundo, sem ninguem precisar limpar cache na mao.
#
# O grep final e proposital: se alguem mudar a forma como o index.html referencia
# o app.js, o build para aqui em vez de gerar uma imagem que volta a servir codigo
# velho de forma silenciosa.
RUN set -e; \
    cd /usr/share/nginx/html; \
    for f in js/app.js js/chart.umd.min.js css/style.css; do \
      v=$(md5sum "$f" | cut -c1-10); \
      sed -i "s|\"$f\"|\"$f?v=$v\"|g" index.html; \
    done; \
    grep -q 'js/app.js?v=' index.html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

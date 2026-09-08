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

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

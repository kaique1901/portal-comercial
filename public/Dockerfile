FROM nginx:alpine

# Proxy reverso de /api/ para o container da API. Sem isto o front chama
# http://<host>:4001 direto e, quando a pagina e servida por HTTPS (producao,
# atras do openresty), o navegador bloqueia como Mixed Content antes mesmo de a
# requisicao sair — o sintoma na tela e "Failed to fetch". Com o proxy, a chamada
# fica same-origin e herda o HTTPS da borda.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copiar os arquivos estáticos para o diretório padrão do Nginx
COPY . /usr/share/nginx/html

# Expor a porta 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

FROM nginx:alpine

# Proxy reverso de /api/ para o container da API (evita Mixed Content quando
# o front é servido via HTTPS por um proxy externo, e chamadas ficam same-origin)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copiar os arquivos estáticos para o diretório padrão do Nginx
COPY . /usr/share/nginx/html

# Expor a porta 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

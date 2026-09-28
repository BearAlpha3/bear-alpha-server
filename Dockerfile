FROM node:20-alpine

WORKDIR /app

COPY . .

RUN echo "===== ARQUIVOS DO PROJETO =====" && \
    find /app -maxdepth 4 -type f | sort

RUN test -f /app/package.json || \
    (echo "ERRO: package.json nao encontrado" && exit 1)

RUN test -f /app/server.js || \
    (echo "ERRO: server.js nao encontrado na raiz do projeto" && exit 1)

RUN npm install --omit=dev

ENV NODE_ENV=production

EXPOSE 10000

CMD ["node", "/app/server.js"]

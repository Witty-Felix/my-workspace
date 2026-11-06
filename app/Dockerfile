FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8090
ENV DATA_DIR=/app/data

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s \
  CMD wget -qO- http://127.0.0.1:8090/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]

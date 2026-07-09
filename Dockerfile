# HKL-Plan-Backend: liefert die Web-App (index.html) aus und persistiert den
# App-Zustand serverseitig (data/state.json). Reine Node-Standardbibliothek —
# keine Laufzeit-Abhängigkeiten, daher kein npm install nötig.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4180 \
    DOCS_DIR=/app/web \
    DATA_DIR=/data

WORKDIR /app

# Nur die Quellen kopieren (keine Abhängigkeiten). Die Web-App (index.html)
# landet unter /app/web, das der Server als DOCS_DIR ausliefert.
COPY package.json server.js ./
COPY index.html ./web/index.html

# Persistenz-Verzeichnis (per Volume gemountet) gehört dem unprivilegierten
# node-Benutzer, damit der Server ohne root schreiben kann.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 4180
VOLUME ["/data"]

# Healthcheck über den vom Frontend genutzten /api/health-Endpunkt (busybox wget).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]

FROM node:22-slim

# ffmpeg   : Tonspur auf 16 kHz Mono umrechnen
# python3  : traegt yt-dlp und faster-whisper
# ca-certificates: sonst scheitert jeder HTTPS-Abruf
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Eigenes venv, damit pip nicht mit Debians Systempaketen kollidiert
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

RUN pip install --no-cache-dir \
      yt-dlp \
      faster-whisper

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY prompts ./prompts

# tsx laeuft zur Laufzeit - bei dieser Groessenordnung ist ein Build-Schritt
# reiner Zusatzaufwand ohne Gegenwert.
RUN npm install --no-save tsx

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WHISPER_MODEL_DIR=/app/data/models

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]

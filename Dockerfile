# ── Stufe 1: Abhaengigkeiten ─────────────────────────────────────────────────
# better-sqlite3 bringt eine binding.gyp mit, weshalb npm es aus dem Quelltext
# uebersetzen will - auch wenn das Paket fertige Binaerdateien enthaelt. Dafuer
# braucht es make und g++, die im schlanken Node-Image fehlen.
#
# Das passiert deshalb in einer eigenen Stufe: Die Werkzeugkette (~250 MB) bleibt
# aussen vor, ins Laufzeit-Image wandert nur das fertige node_modules.
FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      build-essential \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stufe 2: Laufzeit ────────────────────────────────────────────────────────
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

# yt-dlp[default,curl-cffi]: curl-cffi liefert die Browser-Fingerabdruecke, ohne
# die TikTok seine Challenge nicht freigibt ("Unexpected response from webpage
# request"). Ohne dieses Extra meldet --list-impersonate-targets alles als
# "unavailable" - und der Fehler sieht wie ein kaputter Extraktor aus.
RUN pip install --no-cache-dir \
      "yt-dlp[default,curl-cffi]" \
      faster-whisper

WORKDIR /app

# Fertig uebersetzte Module aus Stufe 1 - hier wird nichts mehr gebaut.
COPY --from=deps /app/node_modules ./node_modules

COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY prompts ./prompts

# tsx laeuft zur Laufzeit - bei dieser Groessenordnung ist ein Build-Schritt
# reiner Zusatzaufwand ohne Gegenwert. Es steckt deshalb in dependencies,
# nicht in devDependencies.

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WHISPER_MODEL_DIR=/app/data/models

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]

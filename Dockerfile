# Conteneur du panneau + pipeline : Node 22 + ffmpeg + CLI claude (FORFAIT, jamais de cle API).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# CLI Claude Code — auth via CLAUDE_CODE_OAUTH_TOKEN (jeton `claude setup-token`)
RUN npm install -g @anthropic-ai/claude-code@2.1.185

WORKDIR /app
COPY . .

# Panneau joignable par le routeur Railway (0.0.0.0). Donnees (compte/session) sur /data.
ENV HOST=0.0.0.0 \
    DATA_DIR=/data \
    TZ=Europe/Paris \
    NODE_ENV=production

# Railway injecte PORT ; le serveur lit PANEL_PORT || PORT (defaut 8770 en local).
CMD ["node", "src/panel-server.mjs"]

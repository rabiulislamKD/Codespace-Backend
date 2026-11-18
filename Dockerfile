# syntax=docker/dockerfile:1

# CodeSpace agent server (the "Free server" / Render bridge).
# Build from this folder:
#   docker build -t codespace-agent .
#   docker run -p 8787:8787 -e CODESPACE_API_TOKEN=change-me codespace-agent
#
# On Render, set the service Root Directory to codespace-core-3.18.4 and add
# CODESPACE_API_TOKEN as a secret. Render supplies PORT and RENDER_EXTERNAL_HOSTNAME.
#
# The Docker CLI below is required by the sandbox engine. It does not start a
# daemon inside this image. For real containers, either:
#   1. run this image on a Linux host and mount /var/run/docker.sock (see
#      docker-compose.sandbox-host.yml), or
#   2. point DOCKER_HOST at a remote Docker daemon over TLS.
# Render's own container has no Docker socket, so sandbox providers stay
# unavailable there unless a remote daemon is configured.
FROM docker:27-cli AS dockercli

FROM node:22-bookworm-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

ENV NODE_ENV=production \
    PORT=8787 \
    CODESPACE_HOST=0.0.0.0 \
    MY_AGENT_DATA_DIR=/data \
    CHROME_PATH=/usr/bin/chromium \
    CODESPACE_CHROME_NO_SANDBOX=1 \
    npm_config_update_notifier=false

# git/python are used by the coding tools; Chromium powers the Browser panel and
# browser tool calls. The container runs as the unprivileged node user, so Chrome
# is started with --no-sandbox via CODESPACE_CHROME_NO_SANDBOX.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      curl \
      fonts-liberation \
      git \
      procps \
      python3 \
      python3-pip \
      python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only runtime dependencies. There are no native modules in this package.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /data /workspace \
 && chown -R node:node /app /data /workspace

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Render passes PORT through the environment; agent-server.js reads it automatically.
# /workspace is the folder the agent works in. It is ephemeral unless you attach a
# persistent disk at /workspace (Render disks require a paid instance).
CMD ["node", "agent-server.js", "/workspace"]

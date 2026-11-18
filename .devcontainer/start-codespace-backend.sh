#!/usr/bin/env bash
# Start the CodeSpace agent server inside a GitHub Codespace.
# The Android app connects to the public forwarded port with the token below.
# Includes resource monitoring and mitigation for free-tier Codespaces (2 vCPU / 8 GB).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$HOME/.codespace-agent"
LOG="$STATE/server.log"
PID_FILE="$STATE/server.pid"
TOKEN_FILE="$STATE/token"
mkdir -p "$STATE/data"

TOKEN="${CODESPACE_API_TOKEN:-}"
GENERATED=0
if [ -z "$TOKEN" ]; then
  if [ -s "$TOKEN_FILE" ]; then
    TOKEN="$(cat "$TOKEN_FILE")"
  else
    TOKEN="$(openssl rand -hex 32)"
    printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    GENERATED=1
  fi
fi

WORKSPACE="${CODESPACE_WORKSPACE:-}"
if [ -z "$WORKSPACE" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  candidate="/workspaces/${GITHUB_REPOSITORY#*/}"
  [ -d "$candidate" ] && WORKSPACE="$candidate"
fi
WORKSPACE="${WORKSPACE:-/workspaces}"

# ============================================================
# Resource monitoring and mitigation for free-tier Codespaces
# ============================================================
FREE_TIER_CPUS=2
FREE_TIER_MEM_MB=8192
MAX_DOCKER_MEMORY_MB=3072  # Leave ~5GB for agent server, OS, AI
MAX_CONCURRENT_SANDBOXES=1
SANDBOX_CPU_LIMIT=1
SANDBOX_MEMORY_MB=2048

# Export resource limits for agent-server.js and sandbox-manager.js
export CODESPACE_MAX_SANDBOXES="$MAX_CONCURRENT_SANDBOXES"
export CODESPACE_SANDBOX_CPU_LIMIT="$SANDBOX_CPU_LIMIT"
export CODESPACE_SANDBOX_MEMORY_MB="$SANDBOX_MEMORY_MB"
export NODE_OPTIONS="--max-old-space-size=2048"  # Limit Node heap to 2GB

# Start resource monitor in background
(
  while true; do
    sleep 30
    # Check memory
    MEM_AVAILABLE_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 8192)
    MEM_USED_PCT=$(( 100 - MEM_AVAILABLE_MB * 100 / FREE_TIER_MEM_MB ))
    
    # Check CPU load
    LOAD_1MIN=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
    LOAD_INT=${LOAD_1MIN%.*}
    
    # Log resource usage
    echo "[$(date '+%H:%M:%S')] Resources: Mem ${MEM_AVAILABLE_MB}MB free (${MEM_USED_PCT}% used), Load: ${LOAD_1MIN}" >> "$STATE/resources.log"
    
    # Mitigation: If memory < 1GB free or load > 4, pause new sandbox creation
    if [ "$MEM_AVAILABLE_MB" -lt 1024 ] || [ "$LOAD_INT" -gt 4 ]; then
      echo "[$(date '+%H:%M:%S')] HIGH RESOURCE USAGE - pausing sandbox creation" >> "$STATE/resources.log"
      touch "$STATE/pause-sandboxes"
    else
      rm -f "$STATE/pause-sandboxes"
    fi
    
    # If critically low (<512MB), restart agent server to free memory
    if [ "$MEM_AVAILABLE_MB" -lt 512 ]; then
      echo "[$(date '+%H:%M:%S')] CRITICAL MEMORY - restarting agent server" >> "$STATE/resources.log"
      kill -TERM "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true
      exit 0  # Let the outer loop restart
    fi
  done
) &
MONITOR_PID=$!
echo $MONITOR_PID > "$STATE/monitor.pid"

# Cleanup on exit
trap 'kill $MONITOR_PID 2>/dev/null; rm -f "$STATE/pause-sandboxes"' EXIT

# ============================================================
# Start agent server with sequential tool execution for free tier
# ============================================================
# Wire free-tier mitigations to the knobs the backend actually reads (the old
# CODESPACE_SEQUENTIAL_TOOLS name was never consumed anywhere).
export CODESPACE_MAX_TASKS=1  # sequential task execution -> lower peak memory (agent-server.js TASK_MAX_CONCURRENT)
export CODESPACE_TOOL_TIMEOUT_MS=120000  # default /run tool timeout in agent-server.js

if curl -fsS --max-time 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  echo "CodeSpace agent server is already running on port 8787."
else
  echo "Starting CodeSpace agent server for $WORKSPACE ..."
  echo "Free-tier mitigations: max_sandboxes=$MAX_CONCURRENT_SANDBOXES, sequential_tools=1, node_heap=2GB"
  (
    cd "$ROOT"
    CODESPACE_API_TOKEN="$TOKEN" \
    CODESPACE_HOST=0.0.0.0 \
    CODESPACE_HOSTED=1 \
    MY_AGENT_DATA_DIR="$STATE/data" \
    nohup node agent-server.js "$WORKSPACE" >>"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
  )
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! curl -fsS --max-time 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  echo "The agent server did not become healthy. See $LOG" >&2
  exit 1
fi

if [ "$GENERATED" = "1" ]; then
  echo "Generated a new API token. Read it with: cat $TOKEN_FILE"
else
  echo "Using CODESPACE_API_TOKEN from the Codespace environment or a previous run."
fi
echo "Server log: $LOG"
echo "Resource log: $STATE/resources.log"
echo "Public URL: https://${CODESPACE_NAME:-YOUR-CODESPACE-NAME}-8787.app.github.dev"
echo "In GitHub: Ports -> 8787 -> Port Visibility -> Public."
echo "In CodeSpace Android: Sandbox -> GitHub Codespace -> Configure GitHub, then paste the URL and token."
echo ""
echo "FREE-TIER NOTICE: This Codespace has 2 vCPU / 8 GB RAM."
echo "  - Only 1 sandbox at a time (CODESPACE_MAX_SANDBOXES=1)"
echo "  - Tools run sequentially (CODESPACE_MAX_TASKS=1)"
echo "  - Node heap limited to 2GB (NODE_OPTIONS=--max-old-space-size=2048)"
echo "  - Resource monitor logs to $STATE/resources.log"
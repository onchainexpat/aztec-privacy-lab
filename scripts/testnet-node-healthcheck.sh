#!/usr/bin/env bash
# Health check for the self-hosted Aztec testnet node stack that backs the
# dashboard's testnet panels (when VITE_TESTNET_NODE_URL points at it).
#
# Run from cron every few minutes. It probes the WHOLE chain through the public
# funnel URL and alerts via Telegram on failure and on recovery, with hourly
# re-reminders while still down (so a single transient blip doesn't spam, but a
# real outage doesn't go silent for a day).
#
# Coverage:
#   1. funnel/node reachable      — node_getBlockNumber via https://…ts.net:8443
#      (catches: Aztec node crashed, Tailscale funnel down, port unbound)
#   2. not stale                  — funnel tip within STALE_THRESHOLD of public tip
#      (catches: Lighthouse/Nethermind stopped feeding L1 data → node frozen)
#   3. beacon + exec sync status  — diagnostic detail attached to alerts
#
# Blind spot: if THIS machine is entirely down, cron can't run and can't alert.
# That's inherent to same-box monitoring; external uptime ping would close it.
#
# Secrets: reads the Telegram bot token + chat id from ~/.claude/channels/telegram
# at runtime — nothing sensitive lives in this (version-controlled) script.

set -uo pipefail

FUNNEL="${FUNNEL_URL:-https://fervor.tail3e3a0c.ts.net:8443}"
PUBLIC="${PUBLIC_RPC:-https://v5.testnet.rpc.aztec-labs.com}"
BEACON="${BEACON_URL:-http://192.168.99.95:5152}"
EXEC="${EXEC_URL:-http://192.168.99.95:8546}"
STALE_THRESHOLD="${STALE_THRESHOLD:-25}"   # L2 blocks behind tip ⇒ stale
REMIND_EVERY="${REMIND_EVERY:-3600}"       # re-alert cadence while still down (s)

DATA_DIR="${AZTEC_DATA_DIR:-/mnt/nodes/aztec-testnet-v4}"
STATE_FILE="$DATA_DIR/healthcheck.state"   # "<UP|DOWN> <last_alert_epoch>"
LOG="$DATA_DIR/healthcheck.log"

# --- Telegram creds from the local channel config (not committed) ---
TG_ENV="$HOME/.claude/channels/telegram/.env"
TG_ACCESS="$HOME/.claude/channels/telegram/access.json"
[ -f "$TG_ENV" ] && { set -a; . "$TG_ENV"; set +a; }
TG_CHAT="$(python3 -c "import json;print(json.load(open('$TG_ACCESS'))['allowFrom'][0])" 2>/dev/null || true)"

send_tg() {
  local msg="$1"
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT:-}" ] || return 0
  curl -s -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" \
    --data-urlencode "text=${msg}" >/dev/null 2>&1
}

rpc_blocknum() {  # $1=url → prints integer block number or nothing
  curl -s -m 12 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"node_getBlockNumber","params":[]}' "$1" 2>/dev/null \
    | python3 -c "import json,sys
try:
    r=json.load(sys.stdin).get('result')
    print(int(r) if r is not None else '')
except Exception:
    print('')" 2>/dev/null
}

ts() { date -u +%FT%TZ; }

problems=()

# 1. funnel/node reachable
funnel_block="$(rpc_blocknum "$FUNNEL")"
[ -z "$funnel_block" ] && problems+=("funnel/node unreachable ($FUNNEL) — Aztec node, funnel, or host down")

# 2. staleness vs public tip
public_block="$(rpc_blocknum "$PUBLIC")"
gap="?"
if [ -n "$funnel_block" ] && [ -n "$public_block" ]; then
  gap=$(( public_block - funnel_block ))
  [ "$gap" -gt "$STALE_THRESHOLD" ] && \
    problems+=("node STALE: ${gap} blocks behind (ours=${funnel_block} public=${public_block}) — check Lighthouse/Nethermind")
fi

# 3. diagnostics (best-effort, never fail the check on these)
beacon_sync="$(curl -s -m 8 "$BEACON/eth/v1/node/syncing" 2>/dev/null | python3 -c "import json,sys
try: print('synced' if json.load(sys.stdin)['data']['is_syncing'] in (False,'false') else 'SYNCING')
except Exception: print('?')" 2>/dev/null)"
exec_sync="$(curl -s -m 8 -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_syncing","params":[]}' "$EXEC" 2>/dev/null \
  | python3 -c "import json,sys
try: print('synced' if json.load(sys.stdin).get('result') is False else 'SYNCING')
except Exception: print('?')" 2>/dev/null)"

# --- state machine (alert on transitions; re-remind hourly while down) ---
prev_state="UP"; last_alert=0
if [ -f "$STATE_FILE" ]; then
  read -r prev_state last_alert < "$STATE_FILE" || true
  [ -z "${last_alert:-}" ] && last_alert=0
fi
now_epoch="$(date +%s)"

if [ "${#problems[@]}" -eq 0 ]; then
  echo "$(ts) UP ours=$funnel_block public=$public_block gap=$gap beacon=$beacon_sync exec=$exec_sync" >> "$LOG"
  if [ "$prev_state" != "UP" ]; then
    send_tg "✅ Aztec testnet node RECOVERED — block ${funnel_block} (gap ${gap}). Funnel serving normally. beacon=${beacon_sync} exec=${exec_sync}"
  fi
  echo "UP $now_epoch" > "$STATE_FILE"
else
  detail="$(printf '• %s\n' "${problems[@]}")"
  echo "$(ts) DOWN: ${problems[*]} | beacon=$beacon_sync exec=$exec_sync" >> "$LOG"
  if [ "$prev_state" != "DOWN" ] || [ "$(( now_epoch - last_alert ))" -ge "$REMIND_EVERY" ]; then
    send_tg "🔴 Aztec testnet node UNHEALTHY (dashboard is on public-RPC fallback):
${detail}
diagnostics: beacon=${beacon_sync} exec=${exec_sync}
host: $(hostname) — $(ts)"
    echo "DOWN $now_epoch" > "$STATE_FILE"
  else
    echo "DOWN $last_alert" > "$STATE_FILE"
  fi
fi

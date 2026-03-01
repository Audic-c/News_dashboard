#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCK_FILE="${PIPELINE_LOCK_FILE:-/tmp/news-dashboard-pipeline.lock}"
REFRESH_CHANNELS="${PIPELINE_REFRESH_CHANNELS:-json,render}"
PUBLISH_CHANNELS="${PIPELINE_PUBLISH_CHANNELS:-publish}"
ENABLE_WECHAT="${PIPELINE_ENABLE_WECHAT:-0}"

log() {
  printf '[pipeline] %s\n' "$*"
}

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another pipeline process is running, exit."
    exit 0
  fi
fi

log "start preflight check"
if [[ "$ENABLE_WECHAT" == "1" ]]; then
  node scripts/preflight-check.js
else
  PREFLIGHT_SKIP_WECHAT=1 node scripts/preflight-check.js
fi

if [[ "$ENABLE_WECHAT" == "1" && -n "${WECHAT_OFFICIAL_ACCOUNT_APP_ID:-}" && -n "${WECHAT_OFFICIAL_ACCOUNT_APP_SECRET:-}" ]]; then
  log "start wechat credential check"
  node scripts/wechat-credential-check.js
fi

log "refresh latest snapshot (live mode): channels=${REFRESH_CHANNELS}"
node scripts/news-overview.js --live --channels "${REFRESH_CHANNELS}"

if [[ "$ENABLE_WECHAT" == "1" ]]; then
  if [[ "${PUBLISH_CHANNELS}" == "publish" ]]; then
    PUBLISH_CHANNELS="publish,wechat_official_account"
  elif [[ "${PUBLISH_CHANNELS}" != *"wechat_official_account"* ]]; then
    PUBLISH_CHANNELS="${PUBLISH_CHANNELS},wechat_official_account"
  fi
fi

log "publish from snapshot: channels=${PUBLISH_CHANNELS}"
node scripts/news-overview.js --snapshot --channels "${PUBLISH_CHANNELS}"

log "pipeline completed"

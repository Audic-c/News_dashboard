#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET_ENV="${1:-${ROOT_DIR}/.env}"
EXAMPLE_ENV="${2:-${ROOT_DIR}/.env.example}"
MODE="${3:---apply}" # --apply | --check

if [[ ! -f "${EXAMPLE_ENV}" ]]; then
  echo "[sync-env] Missing example file: ${EXAMPLE_ENV}" >&2
  exit 1
fi

if [[ ! -f "${TARGET_ENV}" ]]; then
  echo "[sync-env] Target .env not found, creating: ${TARGET_ENV}"
  : > "${TARGET_ENV}"
fi

extract_keys() {
  local file="$1"
  grep -E '^[A-Z0-9_]+=' "$file" | sed -E 's/^([A-Z0-9_]+)=.*$/\1/' | sort -u
}

mapfile -t example_keys < <(extract_keys "${EXAMPLE_ENV}")
mapfile -t target_keys < <(extract_keys "${TARGET_ENV}")

declare -A target_map=()
for key in "${target_keys[@]:-}"; do
  target_map["$key"]=1
done

missing_keys=()
for key in "${example_keys[@]:-}"; do
  if [[ -z "${target_map[$key]:-}" ]]; then
    missing_keys+=("$key")
  fi
done

declare -A example_map=()
for key in "${example_keys[@]:-}"; do
  example_map["$key"]=1
done

extra_keys=()
for key in "${target_keys[@]:-}"; do
  if [[ -z "${example_map[$key]:-}" ]]; then
    extra_keys+=("$key")
  fi
done

echo "[sync-env] Target: ${TARGET_ENV}"
echo "[sync-env] Example: ${EXAMPLE_ENV}"
echo "[sync-env] Missing keys in target: ${#missing_keys[@]}"
if [[ ${#missing_keys[@]} -gt 0 ]]; then
  printf '  - %s\n' "${missing_keys[@]}"
fi

echo "[sync-env] Extra keys in target (not in example): ${#extra_keys[@]}"
if [[ ${#extra_keys[@]} -gt 0 ]]; then
  printf '  - %s\n' "${extra_keys[@]}"
fi

if [[ "${MODE}" == "--check" ]]; then
  echo "[sync-env] Check mode only. No file changes made."
  exit 0
fi

if [[ "${MODE}" != "--apply" ]]; then
  echo "[sync-env] Unknown mode: ${MODE}. Use --apply or --check" >&2
  exit 1
fi

if [[ ${#missing_keys[@]} -eq 0 ]]; then
  echo "[sync-env] No missing keys. Nothing to apply."
  exit 0
fi

backup_path="${TARGET_ENV}.bak.$(date +%Y%m%d-%H%M%S)"
cp "${TARGET_ENV}" "${backup_path}"
echo "[sync-env] Backup created: ${backup_path}"

for key in "${missing_keys[@]}"; do
  line="$(grep -E "^${key}=" "${EXAMPLE_ENV}" | head -n 1 || true)"
  if [[ -n "${line}" ]]; then
    printf '%s\n' "${line}" >> "${TARGET_ENV}"
  fi
done

echo "[sync-env] Applied. Added ${#missing_keys[@]} keys to ${TARGET_ENV}."

#!/usr/bin/env bash
set -euo pipefail

main=${1:-}
if [[ -z "$main" ]]; then
  main=$(find /usr/bin /opt /usr/lib -type f \
    \( -name agentkib-desktop -o -name agentkib -o -name AgentKib \) \
    -perm -u+x -print -quit 2>/dev/null || true)
fi
[[ -x "$main" ]] || { echo "Installed AgentKib executable is missing: $main" >&2; exit 1; }

if ldd "$main" | grep -q 'not found'; then
  echo "Installed AgentKib has unresolved shared libraries" >&2
  ldd "$main" >&2
  exit 1
fi

desktop=$(find /usr/share/applications -maxdepth 1 -type f -iname '*agentkib*.desktop' -print -quit)
[[ -n "$desktop" ]] || { echo "Installed AgentKib desktop entry is missing" >&2; exit 1; }
desktop-file-validate "$desktop"

runtime=$(mktemp -d "${TMPDIR:-/tmp}/agentkib-runtime-smoke.XXXXXX")
pid=
cleanup() {
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$runtime"
}
trap cleanup EXIT

mkdir -p "$runtime/home" "$runtime/config" "$runtime/data" "$runtime/cache"
electron_args=()
if [[ "$(id -u)" -eq 0 ]]; then
  electron_args+=(--no-sandbox)
fi
setsid env \
  HOME="$runtime/home" \
  XDG_CONFIG_HOME="$runtime/config" \
  XDG_DATA_HOME="$runtime/data" \
  XDG_CACHE_HOME="$runtime/cache" \
  GDK_BACKEND=x11 \
  dbus-run-session -- xvfb-run -a "$main" "${electron_args[@]}" >"$runtime/agentkib.log" 2>&1 &
pid=$!
sleep 6

if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid" || status=$?
  echo "Installed AgentKib exited during startup (status ${status:-0})" >&2
  sed -n '1,160p' "$runtime/agentkib.log" >&2
  exit 1
fi

echo "Installed AgentKib remained responsive during the bounded startup probe."

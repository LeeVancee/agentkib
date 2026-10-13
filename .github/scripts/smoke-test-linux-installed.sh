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

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
electron_args=()
if [[ "$(id -u)" -eq 0 ]]; then
  electron_args+=(--no-sandbox)
fi
GDK_BACKEND=x11 dbus-run-session -- xvfb-run -a \
  node "$script_dir/run-desktop-startup-smoke.mjs" "$main" "${electron_args[@]}"

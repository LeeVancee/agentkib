#!/usr/bin/env bash
set -euo pipefail

search_root=${1:-target}
package_kind=${2:-all}
if [[ ! -d "$search_root" ]]; then
  echo "Artifact root does not exist: $search_root" >&2
  exit 1
fi

workspace=$(mktemp -d "${TMPDIR:-/tmp}/agentkib-linux-smoke.XXXXXX")
trap 'rm -rf "$workspace"' EXIT

inspect_tree() {
  local root=$1
  local package=$2
  local main sidecar collector bundle desktop
  main=$(find "$root" -type f \( -name agentkib-desktop -o -name agentkib -o -name AgentKib \) -perm -u+x -print -quit)
  sidecar=$(find "$root" -type f -name agentkib-quota-sidecar -perm -u+x -print -quit)
  collector=$(find "$root" -type f \( -path '*/linux/CodexBarCLI' -o -path '*/CodexBarCLI' \) -perm -u+x -print -quit)
  bundle=$(find "$root" -type d -name CodexBar_CodexBarCore.bundle -print -quit)
  desktop=$(find "$root" -type f -name '*.desktop' -print -quit)
  [[ -n "$main" ]] || { echo "$package: main executable is missing" >&2; return 1; }
  [[ -n "$sidecar" ]] || { echo "$package: quota launcher is missing" >&2; return 1; }
  [[ -n "$collector" ]] || { echo "$package: CodexBarCLI resource is missing or not executable" >&2; return 1; }
  [[ -n "$bundle" ]] || { echo "$package: CodexBar resource bundle is missing" >&2; return 1; }
  [[ -n "$desktop" ]] || { echo "$package: desktop entry is missing" >&2; return 1; }
  local main_mode
  main_mode=$(stat -c '%a' "$main")
  if (( (8#$main_mode & 0011) != 0011 )); then
    echo "$package: main executable is not runnable by non-root users (mode $main_mode)" >&2
    return 1
  fi
  if ldd "$main" | grep -q 'not found'; then
    echo "$package: main executable has unresolved shared libraries" >&2
    ldd "$main" >&2
    return 1
  fi
  if command -v desktop-file-validate >/dev/null 2>&1; then
    desktop-file-validate "$desktop"
  fi
  timeout 15s "$sidecar" dashboard --help >/dev/null 2>&1 || {
    echo "$package: quota launcher could not start its bundled collector" >&2
    return 1
  }
  printf 'Inspected %s\n' "$package"
}

inspect_deb() {
  local package=$1 root=$2
  command -v dpkg-deb >/dev/null || { echo "dpkg-deb is required" >&2; return 1; }
  dpkg-deb -x "$package" "$root"
  inspect_tree "$root" "$package"
}

inspect_rpm() {
  local package=$1 root=$2
  command -v rpm2cpio >/dev/null || { echo "rpm2cpio is required" >&2; return 1; }
  command -v cpio >/dev/null || { echo "cpio is required" >&2; return 1; }
  mkdir -p "$root"
  (cd "$root" && rpm2cpio "$package" | cpio -idm --quiet)
  inspect_tree "$root" "$package"
}

inspect_appimage() {
  local package=$1 root=$2
  mkdir -p "$root"
  chmod +x "$package"
  (cd "$root" && "$package" --appimage-extract >/dev/null)
  inspect_tree "$root/squashfs-root" "$package"
}

count=0
while IFS= read -r -d '' package; do
  package=$(realpath "$package")
  case "$package" in
    *.deb)
      [[ "$package_kind" == all || "$package_kind" == deb ]] || continue
      inspect_deb "$package" "$workspace/deb-$count"
      ;;
    *.rpm)
      [[ "$package_kind" == all || "$package_kind" == rpm ]] || continue
      inspect_rpm "$package" "$workspace/rpm-$count"
      ;;
    *.AppImage)
      [[ "$package_kind" == all || "$package_kind" == appimage ]] || continue
      inspect_appimage "$package" "$workspace/appimage-$count"
      ;;
  esac
  count=$((count + 1))
done < <(find "$search_root" -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -print0 | sort -z)

if ((count == 0)); then
  echo "No matching Linux package found under $search_root" >&2
  exit 1
fi

echo "AgentKib Linux package smoke test passed ($count package(s))."

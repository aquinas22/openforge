#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"
skip_install=false
portable_only=false

usage() {
  printf '%s\n' \
    'Build Openforge Windows artifacts from a Linux host.' \
    '' \
    'Usage: scripts/build-windows-linux.sh [options]' \
    '' \
    'Options:' \
    '  --skip-install   Reuse the existing node_modules directory.' \
    '  --portable-only  Build only the portable Windows executable.' \
    '  -h, --help       Show this help.'
}

while (($# > 0)); do
  case "$1" in
    --skip-install)
      skip_install=true
      ;;
    --portable-only)
      portable_only=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || {
  printf 'Node.js was not found. Install Node.js 20 or newer.\n' >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  printf 'npm was not found. Install npm before building.\n' >&2
  exit 1
}
command -v wine >/dev/null 2>&1 || {
  printf 'Wine was not found. Install Wine before cross-building Windows artifacts.\n' >&2
  exit 1
}
command -v wineboot >/dev/null 2>&1 || {
  printf 'wineboot was not found. Install a complete Wine package before building.\n' >&2
  exit 1
}

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ ! "${node_major}" =~ ^[0-9]+$ ]] || ((node_major < 20)); then
  printf 'Node.js 20 or newer is required. Found %s.\n' "$(node --version)" >&2
  exit 1
fi

cd "${project_root}"
app_version="$(node -p "require('./package.json').version")"
product_name="$(sed -n 's/^productName:[[:space:]]*//p' electron-builder.yml | head -n 1)"
release_dir="${project_root}/release/${app_version}"
wine_prefix="${project_root}/.build-tools/wine-prefix"

printf '\nOpenforge Windows release builder\n'
printf 'Host:    %s\n' "$(uname -srm)"
printf 'Node:    %s\n' "$(node --version)"
printf 'Version: %s\n\n' "${app_version}"
printf 'Online authentication: official Minecraft Launcher.\n\n'

if [[ "${skip_install}" == false ]]; then
  printf 'Installing locked dependencies...\n'
  npm ci
else
  if [[ ! -d node_modules ]]; then
    printf 'node_modules is missing; rerun without --skip-install.\n' >&2
    exit 1
  fi
  printf 'Reusing existing node_modules.\n'
fi

export WINEPREFIX="${wine_prefix}"
export WINEDEBUG="${WINEDEBUG:--all}"
if [[ ! -f "${WINEPREFIX}/system.reg" ]]; then
  printf '\nInitializing isolated Wine prefix...\n'
  mkdir -p "${WINEPREFIX}"
  wineboot --init
fi

printf '\nChecking TypeScript...\n'
npm run typecheck

if [[ "${portable_only}" == true ]]; then
  printf '\nBuilding portable Windows executable...\n'
  npm run dist:portable:linux
else
  printf '\nBuilding Windows installer and portable executable...\n'
  npm run dist:linux
fi

printf '\nRelease artifacts:\n'
artifact_count=0
while IFS= read -r -d '' artifact; do
  artifact_count=$((artifact_count + 1))
  artifact_size="$(du -h "${artifact}" | cut -f1)"
  printf '  %s  %s\n' "${artifact_size}" "${artifact#${project_root}/}"
  sha256sum "${artifact}" | sed 's/^/    sha256: /'
done < <(
  find "${release_dir}" -maxdepth 1 -type f \
    \( -name "${product_name}-*.exe" -o -name "${product_name}-*.zip" \) \
    -print0 | sort -z
)

if ((artifact_count == 0)); then
  printf 'No Windows artifacts were produced in %s.\n' "${release_dir}" >&2
  exit 1
fi

printf '\nBuild complete: %s\n' "${release_dir}"

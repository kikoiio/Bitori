#!/usr/bin/env bash
# Deterministic MyCode -> Bitori rename lever. Safe to rerun; it only rewrites
# files that still contain an old spelling. Excludes generated/vendored trees.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

mapfile -t files < <(rg -l --hidden -S 'MyCodeError|MyCode|mycode' \
  -g '!.git' -g '!node_modules' -g '!dist' -g '!coverage' -g '!.audit' \
  -g '!rename-mycode-to-bitori.sh' . || true)

if ((${#files[@]} == 0)); then
  echo 'No legacy MyCode spellings found.'
  exit 0
fi

# Longest tokens first so class names and dotted paths stay intact.
perl -pi -e 's/MyCodeError/BitoriError/g; s/MyCode/Bitori/g; s/mycode/bitori/g' "${files[@]}"
echo "Renamed ${#files[@]} files."

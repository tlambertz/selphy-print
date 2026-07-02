#!/usr/bin/env bash
# Downloads free ICC profiles for the Canon SELPHY CP1500 into ./profiles,
# where the server auto-discovers them (pick per print in the app). Both are
# provided free of charge by their authors:
#   - farbenwerk (neutral):  https://www.farbenwerk.com/en/blogs/news/canon-selphy-cp1500-icc-profile
#   - objektiv-guide (more saturated):  https://www.objektiv-guide.de/
set -euo pipefail
dir="$(dirname "$0")/../profiles"
mkdir -p "$dir"

# name|url pairs
profiles=(
  "CP1500-farbenwerk.icc|https://files.farbenwerk.com/dl/icc-dl-fw/ICC-Profile165-CP1500.icc"
  "Canon_Selphy_CP1500-objektiv.icc|https://www.objektiv-guide.de/downloads/Canon_Selphy_CP1500.icc"
)

for entry in "${profiles[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  if curl -fL -o "$dir/$name" "$url"; then
    echo "saved $dir/$name"
  else
    echo "WARNING: failed to fetch $name from $url" >&2
  fi
done

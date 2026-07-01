#!/usr/bin/env bash
# Downloads the free farbenwerk ICC profile for the Canon SELPHY CP1500.
# Profile (c) farbenwerk, provided free of charge:
# https://www.farbenwerk.com/en/blogs/news/canon-selphy-cp1500-icc-profile
set -euo pipefail
dir="$(dirname "$0")/../profiles"
mkdir -p "$dir"
curl -fL -o "$dir/CP1500-farbenwerk.icc" \
  'https://files.farbenwerk.com/dl/icc-dl-fw/ICC-Profile165-CP1500.icc'
echo "saved to $dir/CP1500-farbenwerk.icc"

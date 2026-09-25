#!/usr/bin/env bash
# BabySlakh (CC BY 4.0), the first 20 songs of Slakh2100 with every stem and its MIDI, for the note
# benchmark: https://zenodo.org/records/4603870. About 900 MB, unpacked into .dev/babyslakh_16k.
set -euo pipefail
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"
if [[ -d .dev/babyslakh_16k ]]; then echo ".dev/babyslakh_16k is already there"; exit 0; fi
mkdir -p .dev
curl -fL --retry 3 -o .dev/babyslakh_16k.tar.gz "https://zenodo.org/records/4603870/files/babyslakh_16k.tar.gz?download=1"
tar -xzf .dev/babyslakh_16k.tar.gz -C .dev
rm .dev/babyslakh_16k.tar.gz
echo "BabySlakh is in .dev/babyslakh_16k"

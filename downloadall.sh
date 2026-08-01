#!/usr/bin/env bash
set -euo pipefail

find . -type f -name source.txt -print0 |
while IFS= read -r -d '' file; do
    echo $(dirname "$file")
    ./download.js "$(dirname "$file")"
done

#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive_path="$root_dir/rds-ca-layer.zip"
checksum_path="$root_dir/rds-ca-layer.zip.sha256"
expected_entry="certs/rds-ca-bundle.pem"

[[ -f "$archive_path" && -f "$checksum_path" ]]
(cd "$root_dir" && shasum -a 256 -c "$(basename "$checksum_path")")
[[ "$(unzip -Z1 "$archive_path")" == "$expected_entry" ]]
unzip -t "$archive_path" >/dev/null
unzip -p "$archive_path" "$expected_entry" | grep -q -- '-----BEGIN CERTIFICATE-----'
unzip -p "$archive_path" "$expected_entry" | grep -q -- '-----END CERTIFICATE-----'

echo "Verified $archive_path: only $expected_entry is packaged."

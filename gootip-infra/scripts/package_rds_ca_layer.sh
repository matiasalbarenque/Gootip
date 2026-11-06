#!/usr/bin/env bash
set -euo pipefail

region="${1:-us-east-2}"
if [[ "$region" != "us-east-2" ]]; then
  echo "Only us-east-2 is supported by the Gootip contract." >&2
  exit 1
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle_path="$(mktemp)"
archive_path="$root_dir/rds-ca-layer.zip"
checksum_path="$root_dir/rds-ca-layer.zip.sha256"
archive_temp="$(mktemp "${archive_path}.tmp.XXXXXX")"
trap 'rm -f "$bundle_path" "$archive_temp"' EXIT

curl --fail --silent --show-error --location \
  "https://truststore.pki.rds.amazonaws.com/${region}/${region}-bundle.pem" \
  --output "$bundle_path"

grep -q -- '-----BEGIN CERTIFICATE-----' "$bundle_path"
grep -q -- '-----END CERTIFICATE-----' "$bundle_path"

python3 - "$bundle_path" "$archive_temp" <<'PY'
import sys
import zipfile

bundle_path, archive_path = sys.argv[1:]
with open(bundle_path, "rb") as bundle_file:
    bundle = bundle_file.read()

entry = zipfile.ZipInfo("certs/rds-ca-bundle.pem", date_time=(1980, 1, 1, 0, 0, 0))
entry.compress_type = zipfile.ZIP_DEFLATED
entry.external_attr = 0o100644 << 16

with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(entry, bundle)
PY

mv "$archive_temp" "$archive_path"
(cd "$root_dir" && shasum -a 256 "$(basename "$archive_path")" > "$(basename "$checksum_path")")
"$root_dir/scripts/verify_rds_ca_layer.sh"

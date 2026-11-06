#!/usr/bin/env bash
# Build the ARM64 Lambda deployment archive for lambda_db_config.
#
# Dependencies are installed for the Lambda platform (Python 3.13, aarch64
# manylinux 2.28 = Amazon Linux 2023) so the native psycopg binary wheel is
# exactly the one Lambda runs. The archive contains only the package plus those
# wheels; the handler path is gootip_db_config.handler.lambda_handler.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${ROOT}/build"
ARCHIVE="${ROOT}/lambda.zip"

rm -rf "${BUILD}" "${ARCHIVE}"
mkdir -p "${BUILD}"

uv pip install \
  --target "${BUILD}" \
  --python-platform aarch64-manylinux_2_28 \
  --python-version 3.13 \
  --only-binary :all: \
  --quiet \
  -r "${ROOT}/requirements.txt"

# Copy only source; local __pycache__ and .pyc files are never deployed.
rsync -a --exclude '__pycache__' --exclude '*.pyc' \
  "${ROOT}/src/gootip_db_config/" "${BUILD}/gootip_db_config/"

# -X strips extra file attributes so the archive is byte-stable across runs.
(cd "${BUILD}" && zip -r -q -X "${ARCHIVE}" .)

echo "Wrote ${ARCHIVE}"

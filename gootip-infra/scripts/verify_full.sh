#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(cd "$HERE/.." && pwd)"

"$HERE/verify_fast.sh"

# Each distinct Terraform configuration is rendered once and shared by both checks.
python3 scripts/verify_full_driver.py

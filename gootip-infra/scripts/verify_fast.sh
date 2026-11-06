#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Reuse one provider cache; create the default only when the caller set none.
# Normalize a caller-supplied relative path against the repository root so the
# evaluator and every Terraform subprocess agree on one absolute path.
CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
case "$CACHE_DIR" in
  /*) ;;
  *) CACHE_DIR="$ROOT/$CACHE_DIR" ;;
esac
export TF_PLUGIN_CACHE_DIR="$CACHE_DIR"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

terraform fmt -check -recursive

[ -d .terraform ] || terraform init -backend=false
terraform validate

[ -d bootstrap/.terraform ] || terraform -chdir=bootstrap init -backend=false
terraform -chdir=bootstrap validate

# Pure tests only: no Terraform plan is materialized.
# The full driver runs these two classes against its shared rendered plans.
uv run --with pytest==9.1.1 pytest -q \
  -k 'not ExactVpcEndpointCapabilityTests and not LambdaHardeningPolicyTests' scripts/tests

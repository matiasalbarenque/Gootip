#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="gootip-spec09-rotation-$$"
admin_password="$(openssl rand -hex 24)"
auth_password="$(openssl rand -hex 24)"
core_password="$(openssl rand -hex 24)"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "$container_name" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=spec09_admin \
  --env "POSTGRES_PASSWORD=$admin_password" \
  --env POSTGRES_DB=postgres \
  postgres:18-alpine >/dev/null

port="$(docker port "$container_name" 5432/tcp | sed 's/.*://')"
for attempt in {1..60}; do
  if docker exec "$container_name" pg_isready -U spec09_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  if (( attempt == 60 )); then
    printf 'Disposable PostgreSQL did not become ready.\n' >&2
    exit 1
  fi
  sleep 1
done

export SPEC09_ROTATION_ADMIN_URL="postgres://spec09_admin:${admin_password}@127.0.0.1:${port}/postgres"
export SPEC09_ROTATION_AUTH_PASSWORD="$auth_password"
export SPEC09_ROTATION_CORE_PASSWORD="$core_password"

corepack pnpm@12.14.0 --dir "$repo_dir/gootip-auth" run test:integration:rotation
corepack pnpm@12.14.0 --dir "$repo_dir/gootip-core" run test:integration:rotation

#!/bin/bash
# scripts/local-test-stack/start.sh
#
# Brings up a local Postgres + PostgREST + Redis(x2) stack WITHOUT Docker,
# functionally equivalent to docker-compose.test.yml, for environments
# where Docker isn't available (e.g. this sandbox). Idempotent — safe to
# re-run; skips anything already running.
#
# Differences from docker-compose.test.yml, and why:
#   - Runs postgres/redis as native OS services instead of containers.
#   - Adds pgrst-proxy.js in front of bare PostgREST on port 3001, because
#     supabase-js always calls `${SUPABASE_URL}/rest/v1/...` (the path a
#     hosted Supabase project's Kong gateway expects), while a bare
#     `postgrest/postgrest` binary serves routes at the schema root
#     (`/users`, not `/rest/v1/users`). The proxy strips the prefix so
#     both the app and supabase-js work unmodified. See pgrst-proxy.js
#     for the full explanation. This is infrastructure-only; nothing in
#     backend/src changes.
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGREST_BIN="${POSTGREST_BIN:-/tmp/postgrest}"

echo "== Postgres =="
if service postgresql status >/dev/null 2>&1; then
  echo "already running"
else
  service postgresql start
fi
if ! PGPASSWORD=test psql -h localhost -p 5432 -U postgres -lqt 2>/dev/null | grep -qw kith_test; then
  PGPASSWORD=test psql -h localhost -p 5432 -U postgres -c "CREATE DATABASE kith_test;" 2>/dev/null || \
    su - postgres -c "psql -c \"ALTER USER postgres PASSWORD 'test';\" && psql -c \"CREATE DATABASE kith_test;\""
  echo "applying migrations..."
  PGPASSWORD=test psql -h localhost -p 5432 -U postgres -d kith_test -f "$HERE/../../../migrations/001_schema.sql" >/dev/null
  PGPASSWORD=test psql -h localhost -p 5432 -U postgres -d kith_test -f "$HERE/../../../migrations/002_ledger_integrity_and_carry_forward_debt.sql" >/dev/null
  echo "migrations applied"
else
  echo "kith_test already exists"
fi

echo "== Redis (app DB: 6379, integration-test DB: 63790) =="
redis-cli -p 6379 ping >/dev/null 2>&1 || redis-server --daemonize yes --port 6379 --logfile /tmp/redis.log
redis-cli -p 63790 ping >/dev/null 2>&1 || redis-server --daemonize yes --port 63790 --logfile /tmp/redis2.log

echo "== PostgREST (bare, port 3002) =="
if ! curl -s -o /dev/null http://localhost:3002/ 2>/dev/null; then
  cat > /tmp/postgrest.conf << 'EOF'
db-uri = "postgres://postgres:test@localhost:5432/kith_test"
db-schemas = "public"
db-anon-role = "postgres"
jwt-secret = "test-jwt-secret-at-least-32-characters-long"
server-port = 3002
EOF
  if [ ! -x "$POSTGREST_BIN" ]; then
    echo "Downloading PostgREST v12.0.2..."
    curl -sL -o /tmp/postgrest.tar.xz "https://github.com/PostgREST/postgrest/releases/download/v12.0.2/postgrest-v12.0.2-linux-static-x64.tar.xz"
    tar xf /tmp/postgrest.tar.xz -C /tmp
    chmod +x "$POSTGREST_BIN"
  fi
  cd /tmp && setsid "$POSTGREST_BIN" postgrest.conf > /tmp/postgrest.log 2>&1 < /dev/null &
  sleep 2
fi

echo "== pgrst-proxy (port 3001, strips /rest/v1) =="
if ! curl -s -o /dev/null http://localhost:3001/ 2>/dev/null; then
  cd "$HERE" && setsid node pgrst-proxy.js > /tmp/proxy.log 2>&1 < /dev/null &
  sleep 1
fi

echo "== Status =="
service postgresql status
redis-cli -p 6379 ping
redis-cli -p 63790 ping
curl -s -o /dev/null -w "PostgREST (3002): %{http_code}\n" http://localhost:3002/users
curl -s -o /dev/null -w "proxy    (3001): %{http_code}\n" http://localhost:3001/rest/v1/users
echo "stack ready"

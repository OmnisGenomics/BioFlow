#!/usr/bin/env bash
set -euo pipefail

command="${1:-start}"
pgdata="${PGDATA:-${RUNNER_TEMP:-/tmp}/bioflow-pgdata}"
pgsocket_dir="${PGSOCKET_DIR:-${RUNNER_TEMP:-/tmp}/bioflow-pgsocket}"
pgport="${PGPORT:-5432}"
pghost="${PGHOST:-127.0.0.1}"
pglog="${PGLOG:-${RUNNER_TEMP:-/tmp}/bioflow-postgres.log}"

usage() {
  cat >&2 <<'EOF'
usage: ci-local-postgres.sh <start|stop|status>

Environment:
  PGDATA         PostgreSQL data directory.
  PGSOCKET_DIR  Unix socket directory.
  PGPORT        TCP port to bind. Defaults to 5432.
  PGHOST        TCP host to bind. Defaults to 127.0.0.1.
  PGLOG         Log file path.
EOF
}

start_postgres() {
  rm -rf "$pgdata" "$pgsocket_dir"
  mkdir -p "$pgdata" "$pgsocket_dir"

  initdb -D "$pgdata" --auth=trust --username=postgres >/dev/null
  pg_ctl -D "$pgdata" -l "$pglog" -o "-F -k $pgsocket_dir -h $pghost -p $pgport" start >/dev/null
  pg_isready -h "$pghost" -p "$pgport" >/dev/null
}

stop_postgres() {
  if [ -d "$pgdata" ]; then
    pg_ctl -D "$pgdata" -m fast stop >/dev/null 2>&1 || true
  fi
}

status_postgres() {
  pg_isready -h "$pghost" -p "$pgport"
}

case "$command" in
  start)
    start_postgres
    ;;
  stop)
    stop_postgres
    ;;
  status)
    status_postgres
    ;;
  *)
    usage
    exit 2
    ;;
esac

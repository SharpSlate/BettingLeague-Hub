#!/usr/bin/env bash
# Starts (or stops) a throwaway Postgres for the database tests on port 54329.
# Needs the Postgres server binaries; CI uses a service container instead.
# Usage: scripts/local-postgres.sh start|stop
set -euo pipefail
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
DIR=${PG_TEST_DIR:-/var/lib/postgresql/bl-test}
PORT=${PG_TEST_PORT:-54329}
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
case "${1:-start}" in
  start)
    if run "$BIN/pg_ctl -D $DIR/data status" >/dev/null 2>&1; then echo "already running on $PORT"; exit 0; fi
    run "rm -rf $DIR && mkdir -p $DIR && $BIN/initdb -D $DIR/data -A trust -U postgres >/dev/null"
    run "printf \"unix_socket_directories = ''\nport = $PORT\nlisten_addresses = '127.0.0.1'\nfsync = off\n\" >> $DIR/data/postgresql.conf"
    run "$BIN/pg_ctl -D $DIR/data -l $DIR/log -w start >/dev/null"
    echo "postgres running: postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop)
    run "$BIN/pg_ctl -D $DIR/data -w stop >/dev/null 2>&1 || true; rm -rf $DIR"
    echo "stopped"
    ;;
esac

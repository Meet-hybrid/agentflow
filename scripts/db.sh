#!/usr/bin/env bash
# Starts or stops AgentFlow's development Postgres in Docker.
# Uses its own container name and port so it never touches other databases.
set -euo pipefail

NAME="${AGENTFLOW_DB_CONTAINER:-agentflow-postgres}"
PORT="${AGENTFLOW_DB_PORT:-55432}"
PASSWORD="${AGENTFLOW_DB_PASSWORD:-agentflow-dev}"

case "${1:-up}" in
  up)
    if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker start "$NAME" >/dev/null
    else
      docker run -d --name "$NAME" \
        -e POSTGRES_USER=agentflow -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=agentflow \
        -p "127.0.0.1:${PORT}:5432" --memory=256m \
        --health-cmd 'pg_isready -U agentflow' --health-interval 2s \
        postgres:16-alpine >/dev/null
    fi
    for _ in $(seq 1 30); do
      [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
      sleep 1
    done
    # A separate database for the automated tests.
    docker exec "$NAME" psql -U agentflow -tc "select 1 from pg_database where datname='agentflow_test'" \
      | grep -q 1 || docker exec "$NAME" createdb -U agentflow agentflow_test
    echo "postgres://agentflow:${PASSWORD}@127.0.0.1:${PORT}/agentflow"
    ;;
  down)
    docker stop "$NAME" >/dev/null && echo "stopped $NAME"
    ;;
  *)
    echo "usage: db.sh up|down" >&2
    exit 2
    ;;
esac

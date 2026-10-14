#!/usr/bin/env bash
# Runs every test, the database ones included, against a throwaway PostgreSQL in Docker.
# The container is ours alone (echomind-test-pg) and removes itself when stopped:
#   docker stop echomind-test-pg
set -euo pipefail
NAME=echomind-test-pg
PORT=${ECHOMIND_TEST_PG_PORT:-55439}
# The official image through AWS's public mirror, which answers when Docker Hub does not.
IMAGE=${ECHOMIND_TEST_PG_IMAGE:-public.ecr.aws/docker/library/postgres:18-alpine}

if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=test -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$NAME" pg_isready -U postgres -q && break
    sleep 1
  done
fi

TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:$PORT/postgres" exec vitest run "$@"

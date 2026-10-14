#!/usr/bin/env bash
# Builds the bundle on this machine and runs it on echomind-server, then waits for /healthz.
#   pnpm --filter @echomind/server deploy
set -euo pipefail
HOST=${ECHOMIND_HOST:-echomind-server}
URL=${ECHOMIND_SERVER_URL:-https://58.87.77.127:8443}
cd "$(dirname "$0")/.."
CA=../desktop/src-tauri/certs/echomind-ca.pem

ssh "$HOST" 'test -f /srv/echomind/.env && test -f /srv/echomind/certs/server.pem' \
  || { echo "服务器还没准备好：先运行 deploy/setup.sh，再运行 deploy/certs.sh。" >&2; exit 1; }

pnpm build
rsync -az --delete Dockerfile dist migrations "$HOST:/srv/echomind/app/"
rsync -az deploy/compose.yaml "$HOST:/srv/echomind/compose.yaml"
ssh "$HOST" 'cd /srv/echomind && docker compose build -q api && docker compose up -d --remove-orphans'

echo "等待服务就绪…"
for _ in $(seq 1 30); do
  if body=$(curl -fsS --max-time 5 --cacert "$CA" "$URL/healthz" 2>/dev/null); then
    echo "已上线：$body"
    exit 0
  fi
  sleep 2
done
echo "60 秒内没有就绪。看日志：ssh $HOST 'cd /srv/echomind && docker compose logs --tail 50 api worker'" >&2
exit 1

#!/usr/bin/env bash
# Runs on echomind-server after /srv/echomind/src has been pulled: rebuilds the image from that
# checkout, restarts what changed, and waits for /healthz. deploy.sh calls it.
set -euo pipefail
cd /srv/echomind
cp src/apps/server/deploy/compose.yaml compose.yaml

commit=$(git -C src rev-parse --short HEAD)
export ECHOMIND_VERSION="$(TZ=Asia/Shanghai date +%Y-%m-%dT%H:%M)+$commit"
docker compose build -q api
docker compose up -d --remove-orphans

# The certificate names the public IP, so ask for that name but connect locally.
ca=src/apps/desktop/src-tauri/certs/echomind-ca.pem
body=""
for _ in $(seq 1 30); do
  body=$(curl -fsS --max-time 5 --cacert "$ca" --connect-to 58.87.77.127:8443:127.0.0.1:8443 https://58.87.77.127:8443/healthz 2>/dev/null) && break
  body=""
  sleep 2
done
if [ -z "$body" ]; then
  echo "60 秒内没有就绪，最近的日志：" >&2
  docker compose logs --tail 30 api worker >&2
  exit 1
fi

# /healthz is content with the old worker's last heartbeat: wait for the new worker to say it
# started, then make sure it is still up a moment later.
worker=$(docker compose ps -q worker)
for _ in $(seq 1 15); do
  # Not grep -q: stopping early would fail the pipe under pipefail.
  if docker compose logs --since 5m worker 2>/dev/null | grep "worker 已启动.*+$commit\"" >/dev/null; then
    sleep 5
    if [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$worker")" = "true 0" ]; then
      echo "已上线（$commit）：$body"
      exit 0
    fi
    break
  fi
  sleep 2
done
echo "worker 没有正常启动，最近的日志：" >&2
docker compose logs --tail 30 worker >&2
exit 1

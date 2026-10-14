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
for _ in $(seq 1 30); do
  if body=$(curl -fsS --max-time 5 --cacert "$ca" --connect-to 58.87.77.127:8443:127.0.0.1:8443 https://58.87.77.127:8443/healthz 2>/dev/null); then
    echo "已上线（$commit）：$body"
    exit 0
  fi
  sleep 2
done
echo "60 秒内没有就绪，最近的日志：" >&2
docker compose logs --tail 30 api worker >&2
exit 1

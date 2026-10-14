#!/usr/bin/env bash
# One-time setup of /srv/echomind on the server. Safe to run again: it only fills in what is missing.
# The generated secrets are written straight into the server's .env (0600) and never printed.
set -euo pipefail
HOST=${ECHOMIND_HOST:-echomind-server}

ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 /srv/echomind
cd /srv/echomind
install -d -m 755 app backups
install -d -m 700 certs
if [ ! -f .env ]; then
  (
    umask 077
    {
      echo "# EchoMind secrets. Never print or copy this file anywhere."
      echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
      echo "ECHOMIND_DATA_KEY=$(openssl rand -base64 32)"
    } > .env
  )
  echo "已生成 /srv/echomind/.env（数据库密码、数据加密密钥）"
fi
chmod 600 .env
echo "服务器目录已就绪：/srv/echomind"
REMOTE

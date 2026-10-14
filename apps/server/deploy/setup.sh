#!/usr/bin/env bash
# One-time setup of /srv/echomind on the server. Safe to run again: it only fills in what is missing.
# The generated secrets are written straight into the server's .env (0600) and never printed.
# The server pulls the code with its own read-only deploy key; the first run prints the public
# key to add on GitHub (gh repo deploy-key add <file> -R 1017293270/listening), then run this again.
set -euo pipefail
HOST=${ECHOMIND_HOST:-echomind-server}

ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 /srv/echomind
cd /srv/echomind
install -d -m 755 backups
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

key=~/.ssh/listening_deploy
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N "" -C "echomind-server deploy (read-only)" -f "$key"
if ! grep -q "^Host github.com" ~/.ssh/config 2>/dev/null; then
  # GitHub's SSH on port 443 gets through where port 22 is slow or blocked.
  printf 'Host github.com\n    HostName ssh.github.com\n    Port 443\n    User git\n    IdentityFile ~/.ssh/listening_deploy\n    IdentitiesOnly yes\n' >> ~/.ssh/config
  chmod 600 ~/.ssh/config
fi
if [ ! -d src/.git ]; then
  if git clone -q git@github.com:1017293270/listening.git src 2>/dev/null; then
    echo "已拉取代码到 /srv/echomind/src"
  else
    echo "还拉不到代码：把下面这把只读公钥加到 GitHub 仓库的 Deploy keys，再运行一次。"
    cat "$key.pub"
    exit 1
  fi
fi
echo "服务器目录已就绪：/srv/echomind"
REMOTE

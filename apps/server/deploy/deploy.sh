#!/usr/bin/env bash
# Deploys what is on GitHub (listening/main) to echomind-server:
#   pnpm --filter @echomind/server deploy
# The server pulls with its own read-only deploy key and builds there, so push first.
set -euo pipefail
HOST=${ECHOMIND_HOST:-echomind-server}
REMOTE=${ECHOMIND_GIT_REMOTE:-listening}
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "有还没提交的改动。服务器只部署 GitHub 上的代码：先提交并推送。" >&2
  exit 1
fi
git fetch -q "$REMOTE" main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$REMOTE/main")" ]; then
  echo "本地 HEAD 和 $REMOTE/main 不一致：先 git push $REMOTE main。" >&2
  exit 1
fi
ssh "$HOST" 'test -f /srv/echomind/.env && test -f /srv/echomind/certs/server.pem && test -d /srv/echomind/src/.git' \
  || { echo "服务器还没准备好：先运行 apps/server/deploy/setup.sh 和 certs.sh。" >&2; exit 1; }

# Pull first and run the updated script as a separate step, so a script never rewrites itself mid-run.
ssh "$HOST" 'git -C /srv/echomind/src pull -q --ff-only'
ssh "$HOST" 'bash /srv/echomind/src/apps/server/deploy/update.sh'

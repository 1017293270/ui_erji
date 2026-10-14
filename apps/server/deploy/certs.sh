#!/usr/bin/env bash
# EchoMind's own certificate authority, and the server certificate it signs.
#  - The CA key stays on this Mac ($CA_DIR). The server makes its own key and sends only a
#    signing request, so its key never leaves the server.
#  - The desktop app trusts only this CA (apps/desktop/src-tauri/certs/echomind-ca.pem), so a new
#    server certificate needs no new app release.
# Run it again to renew the server certificate: 825 days, the longest macOS accepts.
set -euo pipefail
HOST=${ECHOMIND_HOST:-echomind-server}
IP=${ECHOMIND_IP:-58.87.77.127}
CA_DIR=${ECHOMIND_CA_DIR:-$HOME/.echomind/ca}
OPENSSL=$(command -v /opt/homebrew/bin/openssl || command -v openssl)
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PUBLIC_CA="$ROOT/apps/desktop/src-tauri/certs/echomind-ca.pem"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ ! -f "$CA_DIR/ca.key" ]; then
  mkdir -p "$CA_DIR"
  chmod 700 "$CA_DIR"
  (umask 077 && "$OPENSSL" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CA_DIR/ca.key")
  "$OPENSSL" req -x509 -new -key "$CA_DIR/ca.key" -sha256 -days 3650 \
    -subj "/O=EchoMind/CN=EchoMind Root CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$CA_DIR/ca.pem"
  echo "已生成 EchoMind 根证书：$CA_DIR（私钥只在这台 Mac 上，记得备份到安全的地方）"
fi
mkdir -p "$(dirname "$PUBLIC_CA")"
cp "$CA_DIR/ca.pem" "$PUBLIC_CA"

ssh "$HOST" 'set -e; cd /srv/echomind/certs
  [ -f server.key ] || (umask 077 && openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key)
  openssl req -new -key server.key -subj "/O=EchoMind/CN=echomind-server"' > "$work/server.csr"

cat > "$work/ext.cnf" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=IP:$IP
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EXT
"$OPENSSL" x509 -req -in "$work/server.csr" -CA "$CA_DIR/ca.pem" -CAkey "$CA_DIR/ca.key" \
  -set_serial "0x$("$OPENSSL" rand -hex 15)" -sha256 -days 825 -extfile "$work/ext.cnf" -out "$work/server.pem" 2>/dev/null
"$OPENSSL" verify -CAfile "$CA_DIR/ca.pem" "$work/server.pem" >/dev/null
scp -q "$work/server.pem" "$HOST:/srv/echomind/certs/server.pem"

until=$("$OPENSSL" x509 -in "$work/server.pem" -noout -enddate | cut -d= -f2)
echo "服务器证书已更新：IP $IP，有效期到 $until。"
echo "如果服务已在运行，重启 api 后生效：ssh $HOST 'cd /srv/echomind && docker compose restart api'"

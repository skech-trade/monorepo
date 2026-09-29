#!/usr/bin/env bash
# One-time setup of a fresh Amazon Linux 2023 box for the engine and relayer.
# Safe to run again: every step checks before it acts.
#
#   infra/setup.sh                                  # the `skech` host in ~/.ssh/config
#   SKECH_HOST=other infra/setup.sh                 # another host entry
#   SKECH_DOMAIN=api.example.com infra/setup.sh     # a real name in place of sslip.io
set -euo pipefail
cd "$(dirname "$0")"
HOST="${SKECH_HOST:-skech}"
BUN_VERSION="$(bun --version)"   # the box runs the bun this machine runs
# The name Caddy serves: by default the host's IP as an sslip.io name, which resolves back to it.
IP="$(ssh -G "$HOST" | awk '$1 == "hostname" { print $2 }')"
DOMAIN="${SKECH_DOMAIN:-${IP//./-}.sslip.io}"

scp -q Caddyfile systemd/*.service "$HOST:/tmp/"
ssh "$HOST" sudo BUN_VERSION="$BUN_VERSION" DOMAIN="$DOMAIN" bash -s <<'REMOTE'
set -euo pipefail

# 1 GB of RAM is not enough to compile the engine. 2 GB of swap is.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

dnf install -y -q gcc rsync tar unzip >/dev/null

# The services run as skech, which cannot sudo. ec2-user deploys into /opt/skech as skech.
id skech &>/dev/null || useradd --system --create-home --home-dir /home/skech --shell /bin/bash skech
install -d -o skech -g skech /opt/skech
install -d -m 750 -o root -g skech /etc/skech
[ -f /etc/skech/env ] || install -m 640 -o root -g skech /dev/null /etc/skech/env

sudo -u skech -H BUN_VERSION="$BUN_VERSION" bash -euc '
  cd ~
  [ -x ~/.cargo/bin/cargo ] || curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --no-modify-path
  [ "$(~/.bun/bin/bun --version 2>/dev/null)" = "$BUN_VERSION" ] || curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
'

if ! command -v caddy &>/dev/null; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy
  chmod 755 /usr/local/bin/caddy
fi
id caddy &>/dev/null || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
install -d -o root -g root /etc/caddy
install -m 644 /tmp/Caddyfile /etc/caddy/Caddyfile
echo "SKECH_DOMAIN=$DOMAIN" > /etc/caddy/env
install -m 644 /tmp/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy
systemctl enable skech-engine skech-relayer
echo "setup done: bun $(sudo -u skech /home/skech/.bun/bin/bun --version), $(sudo -u skech /home/skech/.cargo/bin/cargo --version), caddy $(caddy version | cut -d' ' -f1), serving $DOMAIN"
REMOTE

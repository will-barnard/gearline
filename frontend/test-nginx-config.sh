#!/usr/bin/env sh
#
# Validates nginx.conf with the real nginx binary, in the same image the
# frontend uses, before you push.
#
#     ./frontend/test-nginx-config.sh
#
# ── Why this exists ──────────────────────────────────────────────────────────
#
# nginx.conf was once deployed with a duplicate `proxy_read_timeout` — set both
# in proxy-common.conf and in the location blocks that override it. nginx
# rejects duplicate directives outright:
#
#     [emerg] "proxy_read_timeout" directive is duplicate
#
# It refuses to start, so the frontend container crash-loops and the whole app
# is down. Reading the config carefully does not catch this; `nginx -t` does, in
# about two seconds.
#
# Run this before every push that touches nginx.conf or proxy-common.conf.

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="nginx:1.25-alpine"

echo "Validating nginx config with ${IMAGE}..."

# `upstream` hostnames are resolved at request time via the embedded DNS
# resolver, so `nginx -t` does not need the backend to exist. A dummy index.html
# keeps the root directive satisfied.
docker run --rm \
  -v "${DIR}/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "${DIR}/proxy-common.conf:/etc/nginx/proxy-common.conf:ro" \
  "${IMAGE}" \
  nginx -t

echo
echo "Config is valid."

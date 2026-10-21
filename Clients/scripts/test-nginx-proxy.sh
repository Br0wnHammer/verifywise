#!/usr/bin/env bash
# Checks that the frontend image's nginx proxies /api and /v1 to the backend.
#
# Builds the "web" stage of Clients/Dockerfile (the production nginx, its env
# and its config template, without the app build) and runs it next to a stub
# backend that answers with the method and URI it received. A host proxy that
# sends everything to the frontend container relies on these routes: in
# v2.6.2 they pointed at the container's own localhost, so every /v1 call
# returned 503 on a deployment like that.
#
# Usage, from the repository root: Clients/scripts/test-nginx-proxy.sh
set -euo pipefail

PREFIX="vw-nginx-proxy-test-$$"
NET="$PREFIX-net"
IMAGE="$PREFIX-web"
BASE_IMAGE=$(awk '/^FROM nginx:.* AS web/ {print $2}' Clients/Dockerfile)
FAILURES=0

cleanup() {
  docker rm -f "$PREFIX-backend" "$PREFIX-web" "$PREFIX-web-unresolved" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    echo "     expected: $expected"
    echo "     actual:   $actual"
    FAILURES=$((FAILURES + 1))
  fi
}

# curl inside a container: prints "<status> <body>"
request() {
  local container="$1"
  shift
  docker exec "$container" curl -s -o /tmp/body -w '%{http_code}' "$@" >/tmp/vw-status.$$ || true
  echo "$(cat /tmp/vw-status.$$) $(docker exec "$container" cat /tmp/body)"
}

wait_for_nginx() {
  local container="$1" url="${2:-http://localhost/}"
  for _ in $(seq 1 30); do
    if docker exec "$container" curl -s -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL $container did not start"
  docker logs "$container" || true
  exit 1
}

docker build --quiet --target web -t "$IMAGE" -f Clients/Dockerfile . >/dev/null
docker network create "$NET" >/dev/null

STUB_CONF='server { listen 3000; default_type text/plain;
  location /api/client-ip { return 200 "xff $http_x_forwarded_for"; }
  location / { return 200 "backend $request_method $request_uri"; } }'
docker run -d --name "$PREFIX-backend" --network "$NET" --network-alias backend \
  -e STUB_CONF="$STUB_CONF" "$BASE_IMAGE" \
  sh -c 'printf "%s" "$STUB_CONF" > /etc/nginx/conf.d/default.conf && exec nginx -g "daemon off;"' >/dev/null

docker run -d --name "$PREFIX-web" --network "$NET" "$IMAGE" >/dev/null
wait_for_nginx "$PREFIX-backend" http://localhost:3000/
wait_for_nginx "$PREFIX-web"

WEB="$PREFIX-web"
check "GET /v1/models reaches the backend with the /v1 prefix" \
  "200 backend GET /v1/models" "$(request "$WEB" http://localhost/v1/models)"
check "POST /v1/chat/completions reaches the backend" \
  "200 backend POST /v1/chat/completions" \
  "$(request "$WEB" -X POST -H 'Content-Type: application/json' -d '{}' http://localhost/v1/chat/completions)"
check "a /v1 path ending in .js is proxied, not served as a static file" \
  "200 backend GET /v1/files/app.js" "$(request "$WEB" http://localhost/v1/files/app.js)"
check "GET /api keeps its prefix and query string" \
  "200 backend GET /api/users?page=2" "$(request "$WEB" 'http://localhost/api/users?page=2')"

# The backend trusts one hop and reads the last X-Forwarded-For entry as the
# client. Behind a host proxy that must still be the client, not the proxy.
XFF=$(request "$WEB" -H 'X-Forwarded-For: 198.51.100.9, 203.0.113.7' http://localhost/api/client-ip)
check "the client from the host proxy's X-Forwarded-For stays the last entry" \
  "203.0.113.7" "${XFF##*, }"

ROOT=$(request "$WEB" http://localhost/)
check "/ is served by the frontend itself" "200 false" \
  "${ROOT%% *} $([[ "$ROOT" == *"backend GET"* ]] && echo true || echo false)"

RENDERED=$(docker exec "$WEB" cat /etc/nginx/conf.d/default.conf)
check "the rendered config has no unfilled template variables" "false" \
  "$([[ "$RENDERED" == *'${'* ]] && echo true || echo false)"
check "nginx's own variables survive rendering" "true" \
  "$([[ "$RENDERED" == *'proxy_set_header Host $host;'* ]] && echo true || echo false)"

UNAVAILABLE='503 {"detail":"VerifyWise is unavailable, please retry shortly"}'
docker stop "$PREFIX-backend" >/dev/null
check "a stopped backend gives the JSON 503" \
  "$UNAVAILABLE" "$(request "$WEB" http://localhost/v1/models)"

docker run -d --name "$PREFIX-web-unresolved" --network "$NET" \
  -e VW_BACKEND_URL=http://no-such-backend:3000 "$IMAGE" >/dev/null
wait_for_nginx "$PREFIX-web-unresolved"
ROOT=$(request "$PREFIX-web-unresolved" http://localhost/)
check "nginx starts when the backend name does not resolve" "200" "${ROOT%% *}"
check "an unresolvable backend gives the JSON 503" \
  "$UNAVAILABLE" "$(request "$PREFIX-web-unresolved" http://localhost/v1/models)"

rm -f /tmp/vw-status.$$
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "All checks passed"

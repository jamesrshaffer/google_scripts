#!/bin/bash
set -e

REPO_DIR="/home/jim/repo-work/gmailclean-api"
LIVE_DIR="/home/jim/gmailclean-api"
IMAGE="gmailclean-api:latest"
CONTAINER="gmailclean-api"

echo "=== [1/4] git pull ==="
cd "$REPO_DIR"
git pull

echo "=== [2/4] copy to live ==="
cp "$REPO_DIR/index.js"              "$LIVE_DIR/index.js"
cp "$REPO_DIR/public/index.html"     "$LIVE_DIR/public/index.html"
cp "$REPO_DIR/public/domains.html"   "$LIVE_DIR/public/domains.html"
cp "$REPO_DIR/public/protected.html" "$LIVE_DIR/public/protected.html"

echo "=== [3/4] docker build ==="
cd "$LIVE_DIR"
docker build -t "$IMAGE" .

echo "=== [4/4] restart container ==="
docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network gmailclean \
  --env-file "$LIVE_DIR/.env" \
  "$IMAGE"

echo "=== done ==="
docker ps --filter "name=$CONTAINER" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

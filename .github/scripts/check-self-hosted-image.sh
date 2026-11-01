#!/usr/bin/env bash
# Smoke-checks a self-hosted image built from worker/server/Dockerfile
# (kind "server") or worker/container/Dockerfile (kind "job"):
#   .github/scripts/check-self-hosted-image.sh <image> <server|job> <expected multix version>
# It checks the tools a job needs (ImageMagick 7 with JPEG and WebP, ffmpeg),
# that the bundled CLI reports the expected version, that the image runs as
# the non-root `node` user and, for the job image, that its job server answers.
set -euo pipefail

image="${1:?image}"
kind="${2:?kind (server|job)}"
expected="${3:?expected multix version}"

in_image() {
  docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL \
    --entrypoint sh "$image" -c "$1"
}

user=$(docker image inspect -f '{{.Config.User}}' "$image")
if [ "$user" != "node" ]; then
  echo "::error::$image runs as '$user', expected 'node'."
  exit 1
fi
echo "user: $user"

formats=$(in_image 'magick -list format')
for coder in JPEG WEBP; do
  line=$(grep -E "^ *${coder}\* +${coder} +rw" <<<"$formats" || true)
  if [ -z "$line" ]; then
    echo "::error::$image: ImageMagick cannot read and write $coder."
    exit 1
  fi
  echo "magick: $line"
done
magick_version=$(in_image 'magick -version')
echo "${magick_version%%$'\n'*}"

ffmpeg_version=$(in_image 'ffmpeg -hide_banner -version')
echo "${ffmpeg_version%%$'\n'*}"

version=$(in_image 'multix --version')
if [ "$version" != "$expected" ]; then
  echo "::error::$image: multix --version printed '$version', expected '$expected'."
  exit 1
fi
echo "multix: $version"

if [ "$kind" = "job" ]; then
  name="multix-job-check-$$"
  # No --rm: if the job server exits at start, its logs must still be readable.
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL \
    -p 127.0.0.1::8080 "$image" >/dev/null
  if ! ports=$(docker port "$name" 8080/tcp 2>&1); then
    echo "::error::$image: the job server container is not running ($ports)."
    docker logs "$name" || true
    exit 1
  fi
  port=$(sed -n '1s/.*://p' <<<"$ports")
  body=""
  for _ in $(seq 1 30); do
    body=$(curl -fsS "http://127.0.0.1:$port/" 2>/dev/null || true)
    [ -n "$body" ] && break
    sleep 1
  done
  if [ "$body" != '{"ok":true}' ]; then
    echo "::error::$image: job server answered '$body' on GET /."
    docker logs "$name" || true
    exit 1
  fi
  echo "job server: $body"
fi

echo "$image ($kind) passed."

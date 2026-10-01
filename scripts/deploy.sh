#!/bin/sh
# Deploy the latest main on the VPS. Run by GitHub Actions over SSH on every push (forced command), or by hand.
# Wrapped in a function so the whole script is read before `git reset` can replace this file mid-run.
main() {
  set -eu
  cd "$(dirname "$0")/.."
  git fetch --quiet origin main
  git reset --hard --quiet origin/main
  docker compose up -d --build --pull always --remove-orphans # if the build or tests fail, the running version stays up
  docker image prune -f >/dev/null
  echo "deployed $(git rev-parse --short HEAD)"
}
main "$@"
exit

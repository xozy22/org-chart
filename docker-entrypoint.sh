#!/bin/sh
# docker-entrypoint.sh — fix bind-mount permissions, then drop privileges.
#
# When the container is launched without an explicit `--user` override, we
# start as root, ensure the data directory exists and is owned by the
# in-container `app` user, and finally drop to that user before exec'ing
# the Node process. This makes `docker run -v /any/host/path:/app/data`
# Just Work™ regardless of how the host directory is owned.
#
# Users who pin a UID/GID via `--user 1001:1001` (or compose `user: …`)
# bypass this whole dance — we detect that we're already non-root and
# exec the command directly.

set -e

DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  # We're root — adjust ownership of the data dir, then drop to `app`.
  mkdir -p "$DATA_DIR"

  app_uid="$(id -u app)"
  app_gid="$(id -g app)"
  current_uid="$(stat -c '%u' "$DATA_DIR" 2>/dev/null || echo "$app_uid")"
  current_gid="$(stat -c '%g' "$DATA_DIR" 2>/dev/null || echo "$app_gid")"

  if [ "$current_uid" != "$app_uid" ] || [ "$current_gid" != "$app_gid" ]; then
    echo "[entrypoint] adjusting ownership of $DATA_DIR (was $current_uid:$current_gid → $app_uid:$app_gid)"
    if ! chown -R app:app "$DATA_DIR" 2>/dev/null; then
      echo "[entrypoint] WARNING: chown failed — bind-mount may be read-only or owned by an unmapped UID."
      echo "[entrypoint] If you see EACCES errors after this, either:"
      echo "[entrypoint]   - chown the host directory to UID/GID $app_uid:$app_gid, or"
      echo "[entrypoint]   - run the container with: --user \"\$(id -u):\$(id -g)\""
    fi
  fi

  exec su-exec app:app "$@"
fi

# Already non-root (e.g. via Compose `user:` or `--user`) — just run.
exec "$@"

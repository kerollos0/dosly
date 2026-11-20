#!/usr/bin/env sh
# Daily database backup. Install with: crontab -e  ->  30 3 * * * /opt/dosly/deploy/backup.sh
# Keeps the last 7 days locally. Copy the backups folder off the VPS too (rclone to Google Drive, for example).
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose exec -T postgres pg_dump -U dosly -Fc dosly > "backups/dosly-$(date +%F).dump"
find backups -name 'dosly-*.dump' -mtime +7 -delete

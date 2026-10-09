#!/bin/sh
# Daily logical backup of the Slotwise database.
# Restore: gunzip -c backups/slotwise-YYYYMMDD.sql.gz | docker compose exec -T db psql -U slotwise -d slotwise
set -eu
mkdir -p /backups
while true; do
  now_h=$(date -u +%H | sed 's/^0//')
  if [ "${now_h:-0}" -eq "${BACKUP_HOUR:-3}" ] && [ ! -f "/backups/slotwise-$(date -u +%Y%m%d).sql.gz" ]; then
    file="/backups/slotwise-$(date -u +%Y%m%d).sql.gz"
    if pg_dump -h db -U slotwise -d slotwise --no-owner | gzip > "$file.tmp"; then
      mv "$file.tmp" "$file"
      echo "backup written: $file"
    else
      rm -f "$file.tmp"
      echo "backup FAILED" >&2
    fi
    find /backups -name 'slotwise-*.sql.gz' -mtime +14 -delete
  fi
  sleep 600
done

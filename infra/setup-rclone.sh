#!/usr/bin/env bash
# One-time setup: give rclone an R2 upload key, typed in privately.
# Usage:  bash infra/setup-rclone.sh <cloudflare-account-id>
# The key is stored only in rclone's own config (~/.config/rclone/rclone.conf),
# never in this repo or your shell history.
set -euo pipefail

ACCOUNT_ID="${1:?usage: bash infra/setup-rclone.sh <cloudflare-account-id>}"
BUCKET="weatherthen-data"

read -rp "R2 Access Key ID: " KEY
read -rsp "R2 Secret Access Key (typing is hidden): " SECRET
echo

rclone config create r2 s3 provider=Cloudflare \
  access_key_id="$KEY" secret_access_key="$SECRET" \
  endpoint="https://${ACCOUNT_ID}.r2.cloudflarestorage.com" \
  acl=private no_check_bucket=true >/dev/null

if rclone lsf "r2:${BUCKET}" --max-depth 1 >/dev/null 2>&1; then
  echo "Done: rclone can reach the ${BUCKET} bucket."
else
  echo "rclone was set up, but couldn't reach ${BUCKET}. Check the key has Object Read & Write on that bucket."
  exit 1
fi

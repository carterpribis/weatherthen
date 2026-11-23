#!/usr/bin/env bash
# One-time setup for the daily map job (.github/workflows/daily.yml).
# Usage:  bash infra/setup-daily.sh
#
# 1. Lets the GitHub CLI push workflow files (opens a browser page to approve).
# 2. Copies the R2 upload key that rclone already has on this Mac into the GitHub
#    repository's encrypted secrets. The key is piped straight from rclone's config to
#    GitHub; it is never printed, and never written to this repo or your shell history.
#
# To use a separate key for GitHub instead (so it can be revoked on its own), make one
# in the Cloudflare dashboard (R2 > Manage API tokens, Object Read & Write on
# weatherthen-data) and run:  bash infra/setup-daily.sh --new-key
set -euo pipefail

REPO="carterpribis/weatherthen"

if ! gh auth status 2>&1 | grep -q "workflow"; then
  echo "GitHub needs one extra permission to accept workflow files. A browser page will open."
  gh auth refresh -h github.com -s workflow
fi

field() { rclone config show r2 | sed -n "s/^$1 *= *//p"; }

if [[ "${1:-}" == "--new-key" ]]; then
  read -rp "R2 Access Key ID: " KEY
  read -rsp "R2 Secret Access Key (typing is hidden): " SECRET
  echo
else
  KEY="$(field access_key_id)"
  SECRET="$(field secret_access_key)"
fi
ENDPOINT="$(field endpoint)"

if [[ -z "$KEY" || -z "$SECRET" || -z "$ENDPOINT" ]]; then
  echo "Couldn't find the R2 key in rclone's config. Run infra/setup-rclone.sh first."
  exit 1
fi

printf '%s' "$KEY"      | gh secret set R2_ACCESS_KEY_ID     --repo "$REPO"
printf '%s' "$SECRET"   | gh secret set R2_SECRET_ACCESS_KEY --repo "$REPO"
printf '%s' "$ENDPOINT" | gh secret set R2_ENDPOINT          --repo "$REPO"

echo "Done: the three secrets are set on $REPO."

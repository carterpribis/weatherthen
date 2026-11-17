#!/usr/bin/env bash
# One-time setup: save your Copernicus Climate Data Store API key, typed in privately.
# Usage:  bash infra/setup-cds.sh
# Writes ~/.cdsapirc (readable only by you). The key never goes in this repo or
# your shell history. Get the key from https://cds.climate.copernicus.eu/profile
set -euo pipefail

RC="$HOME/.cdsapirc"
if [[ -f "$RC" ]]; then
  read -rp "$RC already exists. Replace it? [y/N] " yn
  [[ "$yn" == [yY]* ]] || { echo "Left it unchanged."; exit 0; }
fi

read -rsp "Paste your CDS API key (typing is hidden): " KEY
echo
KEY="${KEY// /}"
if [[ "$KEY" == *:* ]]; then
  echo "That looks like an old UID:KEY value. Paste only the key (the part after the colon)."
  exit 1
fi
if [[ ${#KEY} -lt 20 ]]; then
  echo "That key looks too short. Copy it again from https://cds.climate.copernicus.eu/profile"
  exit 1
fi

umask 077
printf 'url: https://cds.climate.copernicus.eu/api\nkey: %s\n' "$KEY" > "$RC"
chmod 600 "$RC"
echo "Saved to $RC (only your user can read it)."

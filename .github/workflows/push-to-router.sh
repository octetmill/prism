#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 OctetMill
#
# Download the latest snapshot APK from GitHub Actions and push it to a router.
#
# Usage:
#   sh push-to-router.sh [<router>]
#
# <router>  IP or host; defaults to root@ if no user specified.
#           Defaults to PRISM_ROUTER env var.
# SSH options (port, key, etc.) can be set via PRISM_SSH_OPTS env var.
#
# Downloads the latest successful snapshot build across all branches.
#
# Requires the gh CLI (https://cli.github.com) and gh auth login.
#
# Examples:
#   sh push-to-router.sh 192.168.1.1
#   sh push-to-router.sh admin@192.168.1.1
#   PRISM_ROUTER=192.168.1.1 sh push-to-router.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

ROUTER="${1:-${PRISM_ROUTER:-}}"
[ -n "$ROUTER" ] || die "no router specified — pass it as argument or set PRISM_ROUTER"
case "$ROUTER" in *@*) ;; *) ROUTER="root@$ROUTER" ;; esac

SSH_OPTS="${PRISM_SSH_OPTS:-}"

# ---------------------------------------------------------------------------
# Download latest snapshot from GitHub Actions

command -v gh >/dev/null 2>&1 || die "gh CLI not found — install from https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "not logged in — run: gh auth login"

printf '==> Fetching latest snapshot from GitHub Actions...\n'
RUN_ID=$(gh run list \
    --repo octetmill/prism \
    --workflow snapshot.yml \
    --status success \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId')
[ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] \
    || die "no successful snapshot run found"

DL_DIR="$REPO_DIR/.build/download"
rm -rf "$DL_DIR"
mkdir -p "$DL_DIR"

gh run download "$RUN_ID" --repo octetmill/prism --dir "$DL_DIR"

# gh run download places files under <dir>/<artifact-name>/
APK=$(find "$DL_DIR" -name 'luci-app-prism-*.apk' | LC_ALL=C sort | tail -1)
[ -n "$APK" ] || die "no APK found in downloaded artifact"

printf '==> Package: %s\n' "$(basename "$APK")"

# ---------------------------------------------------------------------------
# Transfer and install in a single SSH session

REMOTE_PATH="/tmp/$(basename "$APK")"
printf '==> Uploading and installing on %s...\n' "$ROUTER"

# shellcheck disable=SC2086
ssh $SSH_OPTS "$ROUTER" "
	cat > '$REMOTE_PATH' &&
	apk add --allow-untrusted '$REMOTE_PATH' &&
	rm -f '$REMOTE_PATH' &&
	service rpcd reload
" < "$APK"
rm -rf "$DL_DIR"

printf '==> Done.\n'

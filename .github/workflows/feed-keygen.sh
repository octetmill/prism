#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 OctetMill
#
# One-time helper: mint the two signing keypairs the Prism package feed
# needs, write the PUBLIC keys into the repo (feed/keys/), and print the
# PRIVATE keys for you to paste into GitHub Actions secrets.
#
#   - usign (ed25519) keypair  -> signs the opkg `Packages` index
#                                 secret: OPKG_SIGN_KEY
#   - RSA keypair (PEM)         -> signs the apk v3 `Packages.adb` index
#                                 secret: APK_SIGN_KEY
#
# The private keys are written to ./.feed-keys/ (git-ignored) and echoed
# below; they are never committed. Run this once, add the two repo
# secrets, commit the public keys under feed/keys/, then push a v* tag —
# pages.yml does the rest.
#
# Requirements: usign, openssl, bash. On Debian/Ubuntu usign builds from
# the OpenWrt source (see .github/actions/install-usign); openssl ships
# with the base system.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || die "'openssl' not found in PATH"
command -v usign   >/dev/null 2>&1 || die "'usign' not found in PATH (build it from .github/actions/install-usign, or 'opkg install usign' on a router)"

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PUB_DIR="$REPO_DIR/feed/keys"
SEC_DIR="$REPO_DIR/.feed-keys"

mkdir -p "$PUB_DIR" "$SEC_DIR"
chmod 700 "$SEC_DIR"

[ -f "$SEC_DIR/prism-feed.sec" ] && die "$SEC_DIR/prism-feed.sec already exists — refusing to overwrite an existing key. Remove .feed-keys/ by hand if you really mean to re-mint."

# --- usign (opkg) -----------------------------------------------------------
# usign writes a fingerprint-stamped ed25519 keypair. The .sec file is the
# secret; the .pub file is what routers trust via `opkg-key add`.
usign -G \
	-s "$SEC_DIR/prism-feed.sec" \
	-p "$PUB_DIR/prism-feed.pub" \
	-c "Prism package feed (octetmill/prism)"

# --- RSA (apk v3) -----------------------------------------------------------
# apk mkndx --sign-key takes a plain RSA private key; the public half goes
# in /etc/apk/keys/ on the router. apk v3 matches by key identity, so the
# published filename is cosmetic.
openssl genrsa -out "$SEC_DIR/prism-feed.rsa" 2048 2>/dev/null
openssl rsa -in "$SEC_DIR/prism-feed.rsa" -pubout -out "$PUB_DIR/prism-feed.rsa.pub" 2>/dev/null
chmod 600 "$SEC_DIR/prism-feed.rsa" "$SEC_DIR/prism-feed.sec"

cat <<EOF

Keys generated.

  Public keys (commit these):
    feed/keys/prism-feed.pub        (usign / opkg)
    feed/keys/prism-feed.rsa.pub    (RSA / apk)

  Private keys (DO NOT commit — kept in .feed-keys/, git-ignored):
    .feed-keys/prism-feed.sec
    .feed-keys/prism-feed.rsa

Add these two GitHub Actions secrets (Settings -> Secrets and variables ->
Actions). Paste the full file contents verbatim:

  OPKG_SIGN_KEY   <- contents of .feed-keys/prism-feed.sec
  APK_SIGN_KEY       <- contents of .feed-keys/prism-feed.rsa

Quick copy on Linux:

  gh secret set OPKG_SIGN_KEY < .feed-keys/prism-feed.sec
  gh secret set APK_SIGN_KEY     < .feed-keys/prism-feed.rsa

Then:  git add feed/keys && git commit -m "feed: add signing public keys"
EOF

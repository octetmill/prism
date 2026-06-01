#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 OctetMill
#
# Assembles the Prism package feed — an OpenWrt-style repository a router
# can add and then `update` / `install` / `upgrade` from. Output tree:
#
#   $FEED_OUT/
#     index.html               landing page with install instructions
#     keys/prism-feed.pub       usign public key (opkg trusts via opkg-key)
#     keys/prism-feed.pem       EC public key (apk trusts in /etc/apk/keys)
#     apk/                      *.apk + signed Packages.adb (apk v3 / 25.12+)
#     opkg/                     *.ipk + Packages(.gz) + Packages.sig (24.10)
#
# The feed serves EVERY v* release (not just the newest) so old versions
# stay installable and apk/opkg can resolve upgrades. The package is
# `noarch`/`all`, so one index per format covers every architecture — no
# per-arch subdirectories.
#
# Inputs (env):
#   FEED_OUT          output dir                       (default ./public)
#   APK_SIGN_KEY_FILE  path to the apk signing key (EC prime256v1)   (required)
#   OPKG_SIGN_KEY_FILE path to the opkg signing key (usign private)  (required)
#   FEED_SRC_DIR      pre-populated dir of *.apk/*.ipk; skips the gh
#                     download (for local testing)              (optional)
#   PAGES_URL         absolute feed URL baked into index.html
#                     (default https://octetmill.github.io/prism)
#
# Requirements: apk (apk-tools 3.x, for mkndx), usign, gzip, tar, ar,
# sha256sum, awk, find; gh (only when FEED_SRC_DIR is unset).
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH"; }

for cmd in apk usign gzip tar ar sha256sum awk find; do require_cmd "$cmd"; done

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
FEED_OUT="${FEED_OUT:-$REPO_DIR/public}"
PAGES_URL="${PAGES_URL:-https://octetmill.github.io/prism}"
KEYS_SRC="$REPO_DIR/feed/keys"

[ -n "${APK_SIGN_KEY_FILE:-}" ] && [ -f "$APK_SIGN_KEY_FILE" ] || die "APK_SIGN_KEY_FILE not set or missing"
[ -n "${OPKG_SIGN_KEY_FILE:-}" ] && [ -f "$OPKG_SIGN_KEY_FILE" ] || die "OPKG_SIGN_KEY_FILE not set or missing"
[ -f "$KEYS_SRC/prism-feed.pub" ]     || die "missing $KEYS_SRC/prism-feed.pub — run feed-keygen.sh and commit feed/keys/"
[ -f "$KEYS_SRC/prism-feed.pem" ] || die "missing $KEYS_SRC/prism-feed.pem — run feed-keygen.sh and commit feed/keys/"

APK_DIR="$FEED_OUT/apk"
OPKG_DIR="$FEED_OUT/opkg"
rm -rf "$FEED_OUT"
mkdir -p "$APK_DIR" "$OPKG_DIR" "$FEED_OUT/keys"

# ---------------------------------------------------------------------------
# Gather every v* release's packages. release.yml uploads platform-tagged
# copies (…-openwrt-25.12.apk / …-openwrt-24.10.ipk); strip that suffix to
# recover the canonical package.sh filename, which is what apk mkndx's
# default name spec and opkg's Filename: field expect.

DL_DIR="$(mktemp -d)"
trap 'rm -rf "$DL_DIR"' EXIT

if [ -n "${FEED_SRC_DIR:-}" ]; then
	cp "$FEED_SRC_DIR"/*.apk "$DL_DIR"/ 2>/dev/null || true
	cp "$FEED_SRC_DIR"/*.ipk "$DL_DIR"/ 2>/dev/null || true
else
	require_cmd gh
	# All release tags except the rolling "snapshot" pre-release.
	gh release list --limit 200 --json tagName,isPrerelease \
		--jq '.[] | select(.tagName | startswith("v")) | .tagName' \
		> "$DL_DIR/tags.txt" || die "gh release list failed"
	[ -s "$DL_DIR/tags.txt" ] || die "no v* releases found — nothing to publish"
	while IFS= read -r tag; do
		[ -n "$tag" ] || continue
		printf 'Fetching assets for %s\n' "$tag"
		gh release download "$tag" --dir "$DL_DIR" \
			--pattern '*.apk' --pattern '*.ipk' --skip-existing || true
	done < "$DL_DIR/tags.txt"
fi

# Canonicalise filenames into the feed dirs.
shopt -s nullglob
for f in "$DL_DIR"/*.apk; do
	base="$(basename "$f")"
	base="${base/-openwrt-25.12/}"
	cp "$f" "$APK_DIR/$base"
done
for f in "$DL_DIR"/*.ipk; do
	base="$(basename "$f")"
	base="${base/-openwrt-24.10/}"
	cp "$f" "$OPKG_DIR/$base"
done
shopt -u nullglob

apk_count=$(find "$APK_DIR" -maxdepth 1 -name '*.apk' | wc -l)
ipk_count=$(find "$OPKG_DIR" -maxdepth 1 -name '*.ipk' | wc -l)
printf 'Collected %s apk and %s ipk package(s)\n' "$apk_count" "$ipk_count"
[ "$apk_count" -gt 0 ] || die "no .apk packages collected"
[ "$ipk_count" -gt 0 ] || die "no .ipk packages collected"

# ---------------------------------------------------------------------------
# apk v3 — sign each package, then build the signed index. Routers add the
# feed by dropping the plain index URL into customfeeds.list
#   https://…/prism/apk/Packages.adb >> /etc/apk/repositories.d/customfeeds.list
# (apk auto-detects the v3 ndx index from the .adb suffix — no prefix needed)
# and trust keys/prism-feed.pem in /etc/apk/keys/.
#
# The released .apk files are unsigned — package.sh builds them for
# `apk add --allow-untrusted`. An apk feed that installs WITHOUT
# --allow-untrusted needs the packages themselves signed by a trusted key
# (this is what OpenWrt does: it signs every package and the index). So
# re-sign each .apk in place with the feed key via `apk adbsign`, then
# mkndx the now-signed packages into a signed index.
#
# Both apk invocations run with --allow-untrusted: the CI container does
# not carry prism-feed.pem in /etc/apk/keys, so apk cannot verify the
# signature it is itself applying/reading. That only relaxes build-time
# verification here; the signatures embedded in the packages and the index
# are what the router (which does trust the key) verifies. Re-signing
# recompresses each .apk, so the feed copy differs byte-wise from the
# immutable release asset — fine, the index records the new hash.

printf 'Signing apk packages (adbsign)\n'
( cd "$APK_DIR" && apk --allow-untrusted adbsign --sign-key "$APK_SIGN_KEY_FILE" ./*.apk )

printf 'Building apk index (Packages.adb)\n'
( cd "$APK_DIR" && apk --allow-untrusted mkndx --sign-key "$APK_SIGN_KEY_FILE" -o Packages.adb ./*.apk )

# ---------------------------------------------------------------------------
# opkg index — Packages (control stanza + Filename/Size/SHA256sum per pkg),
# gzipped, with a detached usign signature over the uncompressed Packages
# (this is what OpenWrt's buildroot signs and what opkg verifies).

printf 'Building opkg index (Packages, Packages.gz, Packages.sig)\n'
PKGFILE="$OPKG_DIR/Packages"
: > "$PKGFILE"
for ipk in "$OPKG_DIR"/*.ipk; do
	fname="$(basename "$ipk")"
	size="$(wc -c < "$ipk")"
	sha="$(sha256sum "$ipk" | awk '{print $1}')"
	# control.tar.gz lives inside the ipk ar archive; pull out ./control.
	ctrl="$(ar p "$ipk" control.tar.gz | tar -xzO ./control 2>/dev/null || \
	        ar p "$ipk" control.tar.gz | tar -xzO control)"
	{
		printf '%s\n' "$ctrl" | sed '/^[[:space:]]*$/d'
		printf 'Filename: %s\n' "$fname"
		printf 'Size: %s\n' "$size"
		printf 'SHA256sum: %s\n' "$sha"
		printf '\n'
	} >> "$PKGFILE"
done
gzip -9 -k -f "$PKGFILE"
usign -S -m "$PKGFILE" -s "$OPKG_SIGN_KEY_FILE" -x "$OPKG_DIR/Packages.sig"

# ---------------------------------------------------------------------------
# Public keys + landing page.

cp "$KEYS_SRC/prism-feed.pub"     "$FEED_OUT/keys/prism-feed.pub"
cp "$KEYS_SRC/prism-feed.pem" "$FEED_OUT/keys/prism-feed.pem"

cat > "$FEED_OUT/index.html" <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prism package feed</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  code, pre { background: #f4f4f4; border-radius: 4px; }
  pre { padding: .75rem 1rem; overflow-x: auto; }
  code { padding: .1rem .3rem; }
  h2 { margin-top: 2rem; }
  .muted { color: #666; }
</style>
</head>
<body>
<h1>Prism package feed</h1>
<p>An OpenWrt-style repository for
<a href="https://github.com/octetmill/prism">luci-app-prism</a>.
Add it once, then install and upgrade Prism with your package manager.</p>

<h2>OpenWrt 25.12+ (apk)</h2>
<pre><code>wget -O /etc/apk/keys/prism-feed.pem ${PAGES_URL}/keys/prism-feed.pem
echo "${PAGES_URL}/apk/Packages.adb" >> /etc/apk/repositories.d/customfeeds.list
apk update
apk add luci-app-prism
service rpcd reload</code></pre>

<h2>OpenWrt 24.10 (opkg)</h2>
<pre><code>wget -O /tmp/prism-feed.pub ${PAGES_URL}/keys/prism-feed.pub
opkg-key add /tmp/prism-feed.pub
echo "src/gz prism ${PAGES_URL}/opkg" >> /etc/opkg/customfeeds.conf
opkg update
opkg install luci-app-prism
service rpcd reload</code></pre>

<h2>Upgrade</h2>
<pre><code>apk update && apk add -u luci-app-prism     # 25.12+
opkg update && opkg upgrade luci-app-prism  # 24.10</code></pre>

<p class="muted">Signed feed. The keys above are published at
<a href="keys/prism-feed.pem">keys/prism-feed.pem</a> and
<a href="keys/prism-feed.pub">keys/prism-feed.pub</a>.</p>
</body>
</html>
HTML

printf '\nFeed assembled under %s\n' "$FEED_OUT"
printf '  apk:  %s/apk/Packages.adb (+ %s package(s))\n' "$PAGES_URL" "$apk_count"
printf '  opkg: %s/opkg/Packages.gz (+ %s package(s))\n' "$PAGES_URL" "$ipk_count"

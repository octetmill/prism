#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 OctetMill
#
# Builds APK and IPK packages for luci-app-prism.
# Runs on Linux with GNU coreutils — not on the router. (Router scripts
# under root/ remain POSIX/busybox-ash compatible.)
#
# Produces unsigned packages installable with:
#   apk add --allow-untrusted luci-app-prism-*.apk
#   opkg install luci-app-prism_*.ipk
#
# Requirements:
#   bash, apk-tools 3.x (`apk mkpkg`), fakeroot, tar, gzip, ar (binutils),
#   find (GNU), wc, du, awk, sha256sum. git is optional — used only to derive
#   the snapshot version suffix when PRISM_VERSION is unset.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH"
}

for cmd in tar gzip find wc du awk ar apk fakeroot sha256sum; do
	require_cmd "$cmd"
done

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DIR="$REPO_DIR/.build"
STAGE_DIR="$BUILD_DIR/stage"
OUT_DIR="$REPO_DIR/dist"

# ---------------------------------------------------------------------------
# Package metadata
#
# The OpenWrt Makefile is the single source of truth. This standalone builder
# parses the PKG_* / LUCI_* assignments out of it so name, version, release,
# maintainer, license, URL, dependencies and conffiles are never maintained
# in two places.

MAKEFILE="$REPO_DIR/Makefile"
[ -f "$MAKEFILE" ] || die "Makefile not found at $MAKEFILE"

# mk_var NAME — value of a `NAME:=value` assignment, whitespace-trimmed.
mk_var() {
	awk -F':=' -v key="$1" \
		'$1 == key { sub(/^[ \t]+/, "", $2); sub(/[ \t]+$/, "", $2); print $2; exit }' \
		"$MAKEFILE"
}

# mk_block MARKER — body lines of a `MARKER ... endef` define block.
mk_block() {
	awk -v marker="$1" \
		'$0 == marker { grab = 1; next } grab && /^endef/ { exit } grab { print }' \
		"$MAKEFILE"
}

PKG_NAME=$(mk_var PKG_NAME)
PKG_VERSION=$(mk_var PKG_VERSION)
PKG_RELEASE=$(mk_var PKG_RELEASE)
PKG_MAINTAINER=$(mk_var PKG_MAINTAINER)
PKG_LICENSE=$(mk_var PKG_LICENSE)
PKG_URL=$(mk_var PKG_URL)
PKG_DESC=$(mk_var LUCI_TITLE)
LUCI_DEPENDS=$(mk_var LUCI_DEPENDS)
LUCI_PKGARCH=$(mk_var LUCI_PKGARCH)
PKG_CONFFILES=$(mk_block "define Package/${PKG_NAME}/conffiles")

for v in PKG_NAME PKG_VERSION PKG_RELEASE PKG_MAINTAINER PKG_LICENSE \
         PKG_URL PKG_DESC LUCI_DEPENDS LUCI_PKGARCH PKG_CONFFILES; do
	[ -n "${!v}" ] || die "could not parse $v from $MAKEFILE"
done

# Architecture tokens derived from the Makefile's LUCI_PKGARCH, the same way
# OpenWrt's own build system does it (include/package-pack.mk): the ipk
# control file takes LUCI_PKGARCH verbatim, while the apk .PKGINFO uses
# `noarch` for an architecture-independent ("all") package — `all` and
# `noarch` are just the ipk and apk spellings of the same concept, and apk
# rejects the token `all` outright.
PKG_ARCH_IPK="$LUCI_PKGARCH"
case "$LUCI_PKGARCH" in
	*all*) PKG_ARCH_APK=noarch ;;
	*)     PKG_ARCH_APK="$LUCI_PKGARCH" ;;
esac

# APK and IPK dependency strings, both derived from the Makefile's single
# LUCI_DEPENDS list. The two formats differ in version-constraint syntax:
#   APK: "sing-box>=1.12"     (no space, no parentheses)
#   IPK: "sing-box (>= 1.12)" (Debian-style)
# A `(constraint)` token attaches to the package name that precedes it.
PKG_DEPENDS_APK=""
PKG_DEPENDS_IPK=""
for tok in $LUCI_DEPENDS; do
	case "$tok" in
		\(*\))
			constraint=${tok#\(}; constraint=${constraint%\)}
			rel=${constraint%%[0-9]*}
			ver=${constraint#"$rel"}
			PKG_DEPENDS_APK="${PKG_DEPENDS_APK}${constraint}"
			PKG_DEPENDS_IPK="${PKG_DEPENDS_IPK} (${rel} ${ver})"
			;;
		*)
			pkg=${tok#+}
			PKG_DEPENDS_APK="${PKG_DEPENDS_APK:+$PKG_DEPENDS_APK }${pkg}"
			PKG_DEPENDS_IPK="${PKG_DEPENDS_IPK:+$PKG_DEPENDS_IPK, }${pkg}"
			;;
	esac
done

# ---------------------------------------------------------------------------
# Version detection
#
# PKG_VERSION (from the Makefile) is the *next* release being worked toward. The git tag
# records a release after the fact. The two coincide only at the moment of
# tagging.
#
# Priority:
#   1. PRISM_VERSION env var — CI sets this when building from a v* tag.
#      Value is the bare version (e.g. "0.1.0"); PRISM_RELEASE may also be
#      provided to override PKG_RELEASE for -r<N> packaging revisions.
#   2. Otherwise — snapshot: <PKG_VERSION>_pre<N>-r<PKG_RELEASE>
#      where N = commits since the last v* tag (total commits if no tag).
#      Monotonic per commit, sorts before the eventual stable release.

if [ -n "${PRISM_VERSION:-}" ]; then
	PKG_VERSION="$PRISM_VERSION"
	PKG_RELEASE="${PRISM_RELEASE:-$PKG_RELEASE}"
elif command -v git >/dev/null 2>&1 && git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
	LAST_TAG=$(git -C "$REPO_DIR" describe --tags --match 'v[0-9]*' --abbrev=0 2>/dev/null || true)
	if [ -n "$LAST_TAG" ]; then
		PRE_N=$(git -C "$REPO_DIR" rev-list --count "${LAST_TAG}..HEAD")
	else
		PRE_N=$(git -C "$REPO_DIR" rev-list --count HEAD)
	fi
	[ -n "$PRE_N" ] || die "could not compute snapshot commit count (shallow clone?)"
	PKG_VERSION="${PKG_VERSION}_pre${PRE_N}"
fi

# apk's release convention is <version>-r<release>; opkg/ipk uses
# <version>-<release>. PKG_FULL_VER is the apk form (apk package + its
# filename); the ipk control file builds its own from PKG_VERSION/PKG_RELEASE.
PKG_FULL_VER="${PKG_VERSION}-r${PKG_RELEASE}"

# APK: <name>-<version>-r<release>.apk  (no arch suffix)
APK_FILE="${OUT_DIR}/${PKG_NAME}-${PKG_FULL_VER}.apk"

# IPK: <name>_<version>-<release>_<arch>.ipk
IPK_FILE="${OUT_DIR}/${PKG_NAME}_${PKG_VERSION}-${PKG_RELEASE}_${PKG_ARCH_IPK}.ipk"

printf 'Building APK: %s\n' "$(basename "$APK_FILE")"
printf 'Building IPK: %s\n' "$(basename "$IPK_FILE")"

# ---------------------------------------------------------------------------
# Clean and prepare staging tree. Also clear any prior artifacts for this
# package from dist/, so the run leaves a clean output dir.

rm -rf "$BUILD_DIR"
rm -f "$OUT_DIR"/${PKG_NAME}*.apk "$OUT_DIR"/${PKG_NAME}*.apk.sha256 \
      "$OUT_DIR"/${PKG_NAME}*.ipk "$OUT_DIR"/${PKG_NAME}*.ipk.sha256
mkdir -p "$STAGE_DIR" "$OUT_DIR"

# htdocs → /www/luci-static/…
mkdir -p "$STAGE_DIR/www/luci-static/resources/view/prism"
find "$REPO_DIR/htdocs/luci-static/resources/view/prism" -type f -exec sh -c '
	for f; do
		rel="${f#'"$REPO_DIR"'/htdocs/luci-static/resources/view/prism/}"
		dst="'"$STAGE_DIR"'/www/luci-static/resources/view/prism/$rel"
		mkdir -p "$(dirname "$dst")"
		cp "$f" "$dst"
	done
' _ {} +

# root/ → target filesystem; honour executable bits set in git
find "$REPO_DIR/root" -type f -exec sh -c '
	for f; do
		rel="${f#'"$REPO_DIR"'/root/}"
		dst="'"$STAGE_DIR"'/$rel"
		mkdir -p "$(dirname "$dst")"
		cp "$f" "$dst"
		if [ -x "$f" ]; then
			chmod 755 "$dst"
		else
			chmod 644 "$dst"
		fi
	done
' _ {} +

# ---------------------------------------------------------------------------
# Installed size in bytes — measured now, before the APK-only /lib/apk/
# metadata is staged, so the figure matches the IPK's data.tar payload.
# du is correct regardless of file count (unlike xargs|wc|tail, which
# returns only the last batch's subtotal when xargs splits the input).

SIZE_BYTES=$(du -sb "$STAGE_DIR" | awk '{print $1}')
SIZE_BYTES=${SIZE_BYTES:-0}

# ---------------------------------------------------------------------------
# APK package database metadata (installed to /lib/apk/packages/ on target)
# These tell apk which files belong to the package and which are conffiles.

APKMETA_DIR="$STAGE_DIR/lib/apk/packages"
mkdir -p "$APKMETA_DIR"

find "$STAGE_DIR" \( -type f -o -type l \) -printf '/%P\n' | \
	grep -v '^/lib/apk/' | LC_ALL=C sort \
	> "$APKMETA_DIR/${PKG_NAME}.list"

printf '%s\n' "$PKG_CONFFILES" > "$APKMETA_DIR/${PKG_NAME}.conffiles"

# ---------------------------------------------------------------------------
# Install scripts.
#
# post-install / post-upgrade: enable the init script and reload rpcd. The
# `enable` is essential — this standalone builder does not go through the
# OpenWrt SDK, so nothing else creates the /etc/rc.d/S95prism symlink. Without
# it the init script is installed but never invoked at boot and Prism never
# autostarts.
#
# pre-deinstall: stop sing-box and remove the rc.d symlinks so an uninstall
# leaves nothing running and no dangling /etc/rc.d/S95prism behind.

POST_SCRIPT="$BUILD_DIR/post-install.sh"
printf '#!/bin/sh\n[ -n "${IPKG_INSTROOT}" ] || {\n\t/etc/init.d/prism enable\n\tservice rpcd reload\n}\n' > "$POST_SCRIPT"

PRERM_SCRIPT="$BUILD_DIR/pre-deinstall.sh"
printf '#!/bin/sh\n[ -n "${IPKG_INSTROOT}" ] || {\n\t/etc/init.d/prism stop\n\t/etc/init.d/prism disable\n}\n' > "$PRERM_SCRIPT"

# ---------------------------------------------------------------------------
# Build APK using apk mkpkg (apk-tools 3.x)
# Install with: apk add --allow-untrusted <package>.apk
#
# The staging tree is owned by the unprivileged build user; package files must
# be owned by root. chown the tree to 0:0 inside a fakeroot session, save that
# session, and replay it into `apk mkpkg` so the package records root.

FAKEROOT_ENV="$BUILD_DIR/fakeroot.env"
fakeroot -s "$FAKEROOT_ENV" -- chown -R 0:0 "$STAGE_DIR"

fakeroot -i "$FAKEROOT_ENV" -- apk mkpkg \
	--info "name:${PKG_NAME}" \
	--info "version:${PKG_FULL_VER}" \
	--info "description:${PKG_DESC}" \
	--info "arch:${PKG_ARCH_APK}" \
	--info "url:${PKG_URL}" \
	--info "license:${PKG_LICENSE}" \
	--info "maintainer:${PKG_MAINTAINER}" \
	--info "depends:${PKG_DEPENDS_APK}" \
	--script "post-install:${POST_SCRIPT}" \
	--script "post-upgrade:${POST_SCRIPT}" \
	--script "pre-deinstall:${PRERM_SCRIPT}" \
	--files "$STAGE_DIR" \
	--output "$APK_FILE"

sha256sum "$APK_FILE" | awk '{print $1}' > "${APK_FILE}.sha256"

# ---------------------------------------------------------------------------
# Build .ipk (ar archive: debian-binary + control.tar.gz + data.tar.gz)

IPK_BUILD_DIR="$BUILD_DIR/ipk"
mkdir -p "$IPK_BUILD_DIR/control" "$IPK_BUILD_DIR/data"

# data.tar.gz — package files only (exclude APK-specific /lib/apk/ metadata).
# --owner/--group force root ownership; the build runs as an unprivileged user.
DATA_TAR="$IPK_BUILD_DIR/data.tar.gz"
(cd "$STAGE_DIR" && find . ! -path './lib/apk*' | LC_ALL=C sort | \
	tar --no-recursion --owner=0 --group=0 -czf "$DATA_TAR" -T -)

# IPK depends: libc prepended per OpenWrt convention
IPK_DEPS="libc, ${PKG_DEPENDS_IPK}"

cat > "$IPK_BUILD_DIR/control/control" <<EOF
Package: $PKG_NAME
Version: ${PKG_VERSION}-${PKG_RELEASE}
Depends: $IPK_DEPS
Section: luci
Architecture: $PKG_ARCH_IPK
Installed-Size: $SIZE_BYTES
Maintainer: $PKG_MAINTAINER
Description: $PKG_DESC
EOF

printf '%s\n' "$PKG_CONFFILES" > "$IPK_BUILD_DIR/control/conffiles"

# postinst / prerm: the very scripts the APK uses, so both package formats
# behave identically on install, upgrade and removal.
cp "$POST_SCRIPT"  "$IPK_BUILD_DIR/control/postinst"
cp "$PRERM_SCRIPT" "$IPK_BUILD_DIR/control/prerm"
chmod 755 "$IPK_BUILD_DIR/control/postinst" "$IPK_BUILD_DIR/control/prerm"

IPK_CTRL_TAR="$IPK_BUILD_DIR/control.tar.gz"
(cd "$IPK_BUILD_DIR/control" && tar --owner=0 --group=0 -czf "$IPK_CTRL_TAR" ./control ./conffiles ./postinst ./prerm)

printf '2.0\n' > "$IPK_BUILD_DIR/debian-binary"
# Recreate the archive from scratch — ar is modify-in-place by default and
# would leave stale members if the same version were rebuilt.
rm -f "$IPK_FILE"
ar cr "$IPK_FILE" "$IPK_BUILD_DIR/debian-binary" "$IPK_CTRL_TAR" "$DATA_TAR"
sha256sum "$IPK_FILE" | awk '{print $1}' > "${IPK_FILE}.sha256"

# ---------------------------------------------------------------------------

APK_BASE="$(basename "$APK_FILE")"
IPK_BASE="$(basename "$IPK_FILE")"
printf 'APK:     %s  (%d bytes)\n' "$APK_BASE" "$(wc -c < "$APK_FILE")"
printf 'SHA256:  %s\n' "$(cat "${APK_FILE}.sha256")"
printf 'IPK:     %s  (%d bytes)\n' "$IPK_BASE" "$(wc -c < "$IPK_FILE")"
printf 'SHA256:  %s\n' "$(cat "${IPK_FILE}.sha256")"
printf '\nInstall on router (APK; post-install reloads rpcd automatically):\n'
printf '  scp %s root@<router-ip>:/tmp/\n' "$APK_BASE"
printf '  ssh root@<router-ip> '\''apk add --allow-untrusted /tmp/%s'\''\n' "$APK_BASE"
printf '\nInstall on router (IPK/opkg):\n'
printf '  scp %s root@<router-ip>:/tmp/\n' "$IPK_BASE"
printf '  ssh root@<router-ip> '\''opkg install /tmp/%s'\''\n' "$IPK_BASE"

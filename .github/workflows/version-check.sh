#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Checks Prism's version scheme against apk's own parser, so a change to the
# version-building code in package.sh cannot quietly start emitting strings
# apk rejects or orders the wrong way.
#
# This exists because it already happened: a packaging re-release tag
# (v0.8.3-r2) used to be carried into the version BODY, producing
# "0.8.3-r2_git2-r1". apk's grammar treats -r<N> as a terminal revision
# token, so nothing may follow it — `apk mkpkg` rejects such a package and
# the whole snapshot channel stops building. Nothing caught that but reading
# the parser, which is not a control.
#
# Usage:
#   version-check.sh              — run the built-in matrix
#   version-check.sh <version>…   — also require each given version to be
#                                   valid (CI passes the version it just built)
#
# Requires apk-tools 3.x. `apk version -c` prints each invalid argument and
# exits with the count of them; `apk version -t A B` prints <, = or >.
set -euo pipefail

command -v apk >/dev/null 2>&1 || {
	printf 'error: apk not found in PATH (apk-tools 3.x required)\n' >&2
	exit 1
}

fail=0
note() { printf '  %-34s %s\n' "$1" "$2"; }

# --- versions the scheme is allowed to produce --------------------------------
# Release, packaging re-release, snapshot, snapshot carrying a CI run number
# as its release component, and the pre-first-release bootstrap shape.
VALID="
0.9.0-r1
0.9.0-r2
0.9.0_git4-r1
0.9.0_git4-r521
0.9.0_pre7-r1
0.10.0-r1
"

# --- versions that must NOT parse ---------------------------------------------
# The first is the regression described above. The second is the Debian
# release separator, which OpenWrt does not use and apk does not accept
# (see openwrt/openwrt#15656, "1.2-1" rejected).
INVALID="
0.8.3-r2_git2-r1
0.9.0-1
"

# --- orderings the documented guarantee depends on ----------------------------
# Each line is "A B" and must compare strictly A < B. Together these assert:
# a bootstrap build sorts below its release; a snapshot sorts above the
# release it follows; snapshots advance with the commit count and with the
# release component; and the next release outranks every snapshot of the
# previous one.
ORDER="
0.9.0_pre7-r1|0.9.0-r1
0.9.0-r1|0.9.0-r2
0.9.0-r1|0.9.0_git1-r1
0.9.0_git1-r1|0.9.0_git4-r1
0.9.0_git4-r1|0.9.0_git4-r2
0.9.0_git4-r521|0.10.0-r1
"

printf 'Valid versions\n'
for v in $VALID "$@"; do
	[ -n "$v" ] || continue
	if apk version -c "$v" >/dev/null 2>&1; then
		note "$v" "ok"
	else
		note "$v" "REJECTED by apk — expected valid"
		fail=1
	fi
done

printf '\nRejected versions\n'
for v in $INVALID; do
	[ -n "$v" ] || continue
	if apk version -c "$v" >/dev/null 2>&1; then
		note "$v" "ACCEPTED by apk — expected rejected"
		fail=1
	else
		note "$v" "ok (rejected)"
	fi
done

printf '\nOrdering\n'
for pair in $ORDER; do
	[ -n "$pair" ] || continue
	a="${pair%%|*}"
	b="${pair##*|}"
	op=$(apk version -t "$a" "$b" 2>/dev/null || echo '?')
	if [ "$op" = "<" ]; then
		note "$a < $b" "ok"
	else
		note "$a ? $b" "apk says '${op}' — expected '<'"
		fail=1
	fi
done

printf '\n'
if [ "$fail" -ne 0 ]; then
	printf 'version-check: FAILED\n' >&2
	exit 1
fi
printf 'version-check: all checks passed\n'

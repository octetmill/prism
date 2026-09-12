# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 OctetMill
#
# Shared shell helpers for Prism's scripts (/etc/init.d/prism and
# firewall.sh). POSIX sh — sourced, not executed.

# Log a Prism control-plane event to syslog. $1 is the severity
# (info/notice/warn/err); the remaining args form the message.
prism_log() {
	local level
	level="$1"
	shift
	# Normalise 'warn' -> 'warning' so the Status-page log filter (which
	# keys SEV by POSIX names) classifies it correctly. busybox logger
	# accepts both spellings.
	[ "$level" = "warn" ] && level=warning
	logger -p "daemon.$level" -t prism "$@"
}

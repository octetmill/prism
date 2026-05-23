-- SPDX-License-Identifier: GPL-3.0-only
-- Copyright (C) 2026 OctetMill
--
-- Shared helpers for Prism's Lua scripts (build-config and the rpcd handler
-- luci.prism). Loaded via dofile() with an absolute path so
-- it resolves regardless of the caller's working directory or package.path.
-- Lua 5.1 only.

local M = {}

-- Read a whole file. Returns its contents, or nil when it cannot be opened.
function M.read_file(path)
	local f = io.open(path, "r")
	if not f then return nil end
	local s = f:read("*a")
	f:close()
	return s
end

-- True when the path exists and is readable.
function M.file_exists(path)
	local f = io.open(path, "r")
	if f then f:close(); return true end
	return false
end

-- Normalise a UCI option that may be a list, a scalar or absent into an
-- array — empty when the option is absent or blank.
function M.uci_list(s, key)
	local v = s[key]
	if type(v) == "table" then return v end
	if type(v) == "string" and v ~= "" then return { v } end
	return {}
end

-- Split a "provider/name" rule-set token. Returns provider, name — or nil
-- when the token carries no slash (a bare custom-rule-set label).
function M.split_provider_token(token)
	return token:match("^([^/]+)/(.+)$")
end

-- True when a rule-set tag is safe to use as a single path component. A tag
-- becomes the filename RULESETS_DIR/<tag>.srs, so it must not contain "/"
-- (which would escape the directory) or start with "." (".", ".." or a
-- hidden file). Rejecting these keeps a hand-edited or hostile rule-set
-- token from steering a download or a config path outside the rule-set dir.
function M.safe_ruleset_tag(tag)
	return type(tag) == "string" and tag ~= ""
		and not tag:find("/", 1, true)
		and tag:sub(1, 1) ~= "."
end

return M

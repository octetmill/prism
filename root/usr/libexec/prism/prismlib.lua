-- SPDX-License-Identifier: GPL-3.0-only
-- Copyright (C) 2026 OctetMill
--
-- Shared helpers and constants for Prism's Lua scripts (build-config, the
-- rpcd handler luci.prism, test-all-runner and active-watch). Loaded via
-- dofile() with an absolute path so it resolves regardless of the caller's
-- working directory or package.path. Lua 5.1 only.

local M = {}

-- Tags Prism synthesises or sing-box treats as built-ins. A node — manual
-- or from a (possibly hostile) subscription — carrying one of these would
-- collide with the generated outbound and either make sing-box reject the
-- whole config or silently shadow the builtin in UI dropdowns. Shared by
-- luci.prism (drops them at subscription-parse time) and build-config
-- (drops them at emission time) so the two filters cannot drift.
M.RESERVED_TAGS = {
	direct          = true,
	block           = true,
	["basic-auto"]  = true,
}

-- Outbound protocols Prism accepts from subscription payloads. Anything
-- else (notably `ssh`, `tor`, or a future sing-box outbound that takes a
-- filesystem path argument) is rejected. Shared by luci.prism's parser
-- and build-config's sanitiser — the two whitelists are security-relevant
-- and must stay in lock-step. Adding a new sing-box protocol means adding
-- it here AND in build-config's build_node_from_uci / SUB_TYPE_KEYS.
M.ALLOWED_PROTOCOLS = {
	vless       = true,
	vmess       = true,
	trojan      = true,
	shadowsocks = true,
	hysteria2   = true,
	tuic        = true,
	anytls      = true,
	socks       = true,
	-- wireguard requires an explicit private_key + peer block; safe to
	-- accept since the only attacker-controlled paths are inside
	-- well-typed fields (no path/cert references), and it lands as an
	-- endpoint after build-config's build_outbounds split.
	wireguard   = true,
}

-- Per-subscription node files: /etc/prism/nodes/<uid>.json, where uid IS
-- the subscription's UCI section name.
M.NODES_DIR = "/etc/prism/nodes"

-- Ephemeral latency-test instance (--probe mode): clash API host:port and
-- config path. 9091 so the probe instance can run alongside the live
-- instance's API on 9090. Shared by build-config (emits the config) and
-- test-all-runner (starts the instance and probes it).
M.PROBE_CLASH_HOST  = "127.0.0.1:9091"
M.PROBE_CONFIG_PATH = "/var/etc/prism/sing-box-probe.json"

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

-- RFC 3986 percent-encoding for one URL component. Tags and URLs ride in a
-- shell command line via the clash API URL; anything not in the unreserved
-- set ([A-Za-z0-9-._~]) gets %XX-encoded so a tag like "🇭🇰 HK 01" or a URL
-- with a query string round-trips intact through both the shell and HTTP.
function M.url_encode(s)
	if s == nil then return "" end
	return (tostring(s):gsub("([^%w%-%._~])", function(c)
		return string.format("%%%02X", string.byte(c))
	end))
end

-- Split a "provider/name" rule-set token. Returns provider, name — or nil
-- when the token carries no slash (a bare custom-rule-set label).
function M.split_provider_token(token)
	return token:match("^([^/]+)/(.+)$")
end

-- Create a directory with mode 0700 (or tighten an existing one). The
-- sensitive files Prism writes (subscription nodes with embedded proxy
-- credentials, sing-box config, extra.json overrides) live in /etc/prism
-- and /var/etc/prism; default umask 0022 would leave them world-readable
-- and a non-root daemon compromise (dnsmasq, statd, etc.) could exfiltrate
-- every proxy password and subscription URL. Tighten the directory and
-- every newly-written file (M.write_secure below).
function M.secure_mkdir(path)
	os.execute("mkdir -p '" .. path:gsub("'", "'\\''") .. "' 2>/dev/null"
		.. " && chmod 0700 '" .. path:gsub("'", "'\\''") .. "' 2>/dev/null")
end

-- Atomic file write that chmods to 0600 between write and rename. Use for
-- any file that may contain proxy credentials, subscription URLs, the
-- sing-box config, or runtime snapshots — anything in /etc/prism or
-- /var/etc/prism that holds remote-sensitive data. Returns true, or
-- false plus an error string.
function M.write_secure(path, content)
	local dir = path:match("^(.*)/[^/]+$")
	if dir and dir ~= "" then M.secure_mkdir(dir) end
	local tmp = path .. ".tmp"
	local f = io.open(tmp, "w")
	if not f then return false, "cannot open " .. tmp end
	f:write(content)
	f:close()
	os.execute("chmod 0600 '" .. tmp:gsub("'", "'\\''") .. "' 2>/dev/null")
	if not os.rename(tmp, path) then
		os.remove(tmp)
		return false, "rename failed for " .. path
	end
	return true
end

-- List the per-subscription node files in NODES_DIR, sorted by path for
-- deterministic iteration order. Returns an array of { path, uid }.
function M.node_files()
	local out = {}
	local f = io.popen("find " .. M.NODES_DIR .. " -maxdepth 1 -name '*.json' 2>/dev/null")
	if f then
		for path in f:lines() do
			local uid = path:match("/([^/]+)%.json$")
			if uid then out[#out + 1] = { path = path, uid = uid } end
		end
		f:close()
	end
	table.sort(out, function(a, b) return a.path < b.path end)
	return out
end

-- Detect the first DNS server advertised on the WAN interface via ubus.
-- Returns nil when WAN is down, has no DHCP-assigned resolvers, or ubus /
-- jsonc isn't available — callers treat that as "no WAN DNS right now".
-- `jsonc` is the caller's luci.jsonc module (passed in so this library
-- stays require-free).
function M.detect_wan_dns(jsonc)
	if not jsonc then return nil end
	local p = io.popen("ubus call network.interface.wan status 2>/dev/null")
	if not p then return nil end
	local raw = p:read("*a"); p:close()
	if not raw or raw == "" then return nil end
	local ok, st = pcall(jsonc.parse, raw)
	if not ok or type(st) ~= "table" then return nil end
	local servers = st["dns-server"]
	if type(servers) ~= "table" or #servers == 0 then return nil end
	return servers[1]
end

-- Ask procd for the prism service's `singbox` instance table, or nil when
-- procd reports it stopped / missing / unparseable. Must walk the parsed
-- JSON to that specific instance: the prism service may also carry an
-- `active_watch` instance, and a substring grep for `"running":true`
-- would happily match either one. We can't rely on ubus's `instance`
-- parameter to scope the response either: on some procd versions
-- (observed on OpenWrt 24.10 builds) the parameter is accepted but
-- ignored, and the reply still carries every instance.
function M.singbox_instance(jsonc)
	if not jsonc then return nil end
	local f = io.popen("ubus call service list '{\"name\":\"prism\"}' 2>/dev/null")
	if not f then return nil end
	local out = f:read("*a") or ""
	f:close()
	if out == "" then return nil end
	local ok, parsed = pcall(jsonc.parse, out)
	if not ok or type(parsed) ~= "table" then return nil end
	local svc = parsed.prism
	if type(svc) ~= "table" or type(svc.instances) ~= "table" then return nil end
	local inst = svc.instances.singbox
	if type(inst) ~= "table" then return nil end
	return inst
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

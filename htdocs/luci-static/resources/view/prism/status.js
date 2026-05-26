// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Status tab: the dashboard. Answers "is it working?" at a glance and "why
// not?" without leaving the page.
//
// Two distinct concepts, two distinct controls — see the
// "Enable toggle + transient Stop split" entry in docs/decisions.md:
//
//   * Enable toggle (persistent, UCI global.enabled) — installs-but-dormant
//     vs. installed-and-running. Off hides the runtime row entirely; the
//     service won't autostart and the watchdog stays idle.
//   * Stop / Start / Restart (transient, tmpfs marker) — diagnostic
//     pause/resume/cycle without flipping the persistent flag. Reboot
//     clears the marker, so an enabled-but-paused service resumes
//     automatically.
//
// Layout (top → bottom):
//   [ ✓ ] Enable Prism                                   ← persistent
//   ● Running / ○ Paused / ● Stopped  via  <active-node>  [actions]
//   Subscriptions: N · Active rules: N
//   <recent activity — 20-line log tail, auto-refreshed>
//   [View full log] [View generated config]
//   sing-box X.Y.Z · Mode
//
// Two 2s pollers — one for service status (badge + actions + footer), one
// for the log tail. Both are torn down on tab switch via _teardown. The
// full log viewer and the generated-config preview live in on-demand
// modals (the prior Diagnostics panel rendered them inline; here they
// would crowd the glance-first layout).
//
// The active-node line shows `routing.final_outbound` from UCI — the tag
// of the default node the rule chain falls through to (a group counts as a
// node here). Subscription nodes render as "<subscription>/<tag>" so two
// nodes that happen to share a tag across subscriptions can be told apart;
// manual nodes and groups render as the bare tag. Same formatting as the
// Routing tab's dropdown. Read-only here; a follow-up may turn it into an
// inline group switcher.

'use strict';
'require baseclass';
'require rpc';
'require ui';
'require uci';

var callGetStatus = rpc.declare({
	object: 'luci.prism',
	method: 'get_status',
	expect: { '': {} }
});

var callSetEnabled = rpc.declare({
	object: 'luci.prism',
	method: 'set_enabled',
	params: [ 'enabled' ],
	expect: { '': {} }
});

var callStart = rpc.declare({
	object: 'luci.prism',
	method: 'start',
	expect: { '': {} }
});

var callStop = rpc.declare({
	object: 'luci.prism',
	method: 'stop',
	expect: { '': {} }
});

var callRestart = rpc.declare({
	object: 'luci.prism',
	method: 'restart',
	expect: { '': {} }
});

var callGetLog = rpc.declare({
	object: 'luci.prism',
	method: 'get_log',
	params: ['lines'],
	expect: { '': {} }
});

var callGetLogs = rpc.declare({
	object: 'luci.prism',
	method: 'get_logs',
	params: ['lines'],
	expect: { '': {} }
});

var callGetConfig = rpc.declare({
	object: 'luci.prism',
	method: 'get_config',
	expect: { '': {} }
});

var callListOutbounds = rpc.declare({
	object: 'luci.prism',
	method: 'list_outbounds',
	expect: { '': {} }
});

// Pulls each urltest/selector group's currently-active member (clash `now`)
// from the snapshot the active-watch daemon writes every 10s — the same
// view that backs the syslog change-log. Returns { groups: [...] } or
// { error: "clash API disabled", groups: [] } when the feature is off.
var callGetActiveGroups = rpc.declare({
	object: 'luci.prism',
	method: 'get_active_groups',
	expect: { '': {} }
});

// Live throughput, cumulative session totals, open-connection count, and
// (when sing-box exposes it) clash-runtime memory. Same daemon-snapshot
// pattern as get_active_groups — the daemon GETs /connections every 10s,
// diffs the cumulative byte counters to derive bytes/sec, and writes a
// small summary file we read here. Returns { error: "clash API disabled" }
// when the feature flag is off, otherwise an object with zeroed fields
// before the daemon has primed.
var callGetClashStats = rpc.declare({
	object: 'luci.prism',
	method: 'get_clash_stats',
	expect: { '': {} }
});

var TAIL_LINES   = 10;
var POLL_MS      = 2000;
var FULL_LOG_LINES = 500;

// Strip the syslog wrapper, sing-box's redundant inner UTC timestamp, and the
// ANSI color escapes from a single log line. The on-disk format is
//   "Sun May 24 08:34:01 2026 daemon.err sing-box[9596]: +0000 2026-05-24 ...
//    \x1b[31mERROR\x1b[0m [\x1b[38;5;226m6532...\x1b[0m 5.0s] <msg>"
// — half the row is timestamps and ANSI noise. We compress to a single
// "YYYY/MM/DD HH:MM:SS <message>" so the message itself fits the visible
// width of the log box without horizontal scrolling for every line.
var MONTHS = {
	Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
	Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};
// syslog ts (Mon Day HH:MM:SS Year), then "daemon.<sev> <tag>[<pid>]:",
// then sing-box's own optional "+TZ YYYY-MM-DD HH:MM:SS " prefix, then msg.
var LOG_RE = /^\w{3} (\w{3})\s+(\d+) (\d{2}:\d{2}:\d{2}) (\d{4}) \S+ \S+:\s*(?:[+-]\d{4}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+)?(.*)$/;
var ANSI_RE = /\x1b\[[0-9;]*m/g;

function cleanLogLine(line) {
	var s = String(line).replace(ANSI_RE, '');
	var m = s.match(LOG_RE);
	if (!m) return s;
	var mm = MONTHS[m[1]] || '00';
	var dd = (m[2].length < 2 ? '0' : '') + m[2];
	return m[4] + '/' + mm + '/' + dd + ' ' + m[3] + ' ' + m[5];
}

function formatLog(lines) {
	if (!Array.isArray(lines)) return '';
	return lines.map(cleanLogLine).join('\n');
}

// "sing-box version 1.12.17" → "sing-box 1.12.17" (drop the redundant
// "version" word) so the footer template doesn't render "sing-box sing-box ".
function shortVersion(v) {
	if (!v) return _('unknown version');
	return String(v).replace(/^sing-box version\s+/, 'sing-box ');
}

// Compact byte formatting for cumulative totals — binary units (1024)
// because the clash counters are byte counts and the rest of the OpenWrt
// UI uses binary too (status overview, interface stats). Picks the unit
// that fits in three significant digits.
function formatBytes(n) {
	n = Number(n) || 0;
	if (n < 1024) return n + ' B';
	var units = [ 'KiB', 'MiB', 'GiB', 'TiB' ];
	var v = n / 1024;
	for (var i = 0; i < units.length; i++) {
		if (v < 1024 || i === units.length - 1) {
			return (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v))
				+ ' ' + units[i];
		}
		v /= 1024;
	}
}

// Same shape as formatBytes but with a /s suffix. The daemon writes
// integer bytes/sec so we round to whole units in the smallest band.
function formatRate(bps) {
	bps = Number(bps) || 0;
	if (bps <= 0) return '0 B/s';
	return formatBytes(bps) + '/s';
}

// Format the active-outbound tag for display: "<subscription>/<tag>" for a
// subscription node, just "<tag>" for a manual node or a group (groups don't
// appear in list_outbounds, so the lookup misses and falls through to the
// raw tag — which is what we want, a group is a single named entity). Same
// shape as the Routing tab's dropdown labels (routing.js:addServers).
function formatActiveNode(tag, outbounds) {
	if (!tag) return '';
	if (tag === 'direct') return _('direct (no proxy)');
	if (tag === 'block')  return _('block (drop)');
	var subName = {};
	uci.sections('prism', 'subscription').forEach(function(sub) {
		subName[sub['.name']] = sub.name || sub['.name'];
	});
	for (var i = 0; i < (outbounds || []).length; i++) {
		var ob = outbounds[i];
		if (ob.tag !== tag) continue;
		if (ob.subscription && subName[ob.subscription])
			return subName[ob.subscription] + '/' + ob.tag;
		return ob.tag;
	}
	return tag;
}

// Active outbound + rules-row label for the runtime header. Branches on
// prism.global.mode: Expert reads prism.routing.final_outbound and counts
// enabled prism.rule sections; Basic synthesises the outbound from the
// user's basic.server list (single tag, basic-auto for N>1, none for 0)
// and replaces the rule count with a "Basic preset" badge — counting
// dormant Expert rules in Basic mode misleads since they are kept on
// disk but not compiled into the running config.
function runtimeInfo(outbounds) {
	var mode = uci.get('prism', 'global', 'mode');
	if (mode !== 'basic' && mode !== 'expert') mode = 'expert';

	if (mode === 'basic') {
		var servers = uci.get('prism', 'basic', 'server');
		if (!Array.isArray(servers))
			servers = servers ? [ servers ] : [];
		var tag = '';
		if (servers.length === 1)      tag = servers[0];
		else if (servers.length > 1)   tag = 'basic-auto';
		return {
			active:     formatActiveNode(tag, outbounds),
			rulesLabel: _('Routing: Basic preset')
		};
	}

	var ruleCount = uci.sections('prism', 'rule').filter(function(r) {
		return r.enabled !== '0';
	}).length;
	return {
		active:     formatActiveNode(uci.get('prism', 'routing', 'final_outbound') || '', outbounds),
		rulesLabel: _('Active rules: %d').format(ruleCount)
	};
}

// Trigger a browser download of the given JSON text as sing-box.json. Uses a
// Blob URL rather than a data: URL — large configs would otherwise blow past
// the data-URL length limit some browsers still enforce.
function downloadConfig(json) {
	var blob = new Blob([ json ], { type: 'application/json' });
	var url  = URL.createObjectURL(blob);
	var a    = document.createElement('a');
	a.href     = url;
	a.download = 'sing-box.json';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	// Defer revocation a frame so Safari has time to dispatch the download
	// before the URL becomes invalid.
	requestAnimationFrame(function() { URL.revokeObjectURL(url); });
}

return baseclass.extend({
	_statusTimer: null,
	_logTimer:    null,

	load: function() {
		// All RPCs degrade gracefully — a missing one leaves the relevant
		// row blank rather than blanking the tab. get_logs returns
		// { prism: [...], singbox: [...] }; ask for the larger of the two
		// caps so both boxes can fill independently.
		return Promise.all([
			callGetStatus().catch(function() { return {}; }),
			callGetLogs(TAIL_LINES).catch(function() { return {}; }),
			callListOutbounds().catch(function() { return {}; }),
			callGetActiveGroups().catch(function() { return { groups: [] }; }),
			callGetClashStats().catch(function() { return {}; }),
			uci.load('prism').catch(function() { return null; })
		]);
	},

	render: function(results) {
		var status     = (results && results[0]) || {};
		var logsData   = (results && results[1]) || {};
		var outbounds  = ((results && results[2]) || {}).outbounds || [];
		var groupsData = (results && results[3]) || { groups: [] };
		var statsData  = (results && results[4]) || {};
		var prismText  = formatLog(logsData.prism);
		var singboxText = formatLog(logsData.singbox);
		// Cache the outbound list for _updateStatus to reuse when the
		// runtime section is rebuilt on an enable-flip. final_outbound
		// rarely changes mid-session, so a snapshot at load time is fine;
		// the user has to leave the tab to add a node anyway.
		this._outbounds = outbounds;
		this._running   = !!status.running;

		var info     = runtimeInfo(outbounds);
		var active   = info.active;
		var mode     = uci.get('prism', 'inbounds', 'mode') || 'tproxy';
		var subCount = uci.sections('prism', 'subscription').length;

		var self = this;

		var node = E('div', { 'class': 'cbi-map' }, [

			// ── Enable toggle ──────────────────────────────────────────
			// Persistent master switch (UCI global.enabled). Off = the
			// service won't autostart, watchdog stays idle, runtime row
			// hidden. The container is id'd so _updateStatus can refresh
			// the checkbox state without re-rendering the whole panel
			// (matters for a poll discovering an out-of-band UCI change).
			E('div', { 'class': 'cbi-section' }, [
				E('div', {
					'id': 'prism-enable-row',
					'style': 'display:flex; align-items:center; gap:0.6em;'
				}, this._renderEnable(status.enabled))
			]),

			// ── Runtime row ────────────────────────────────────────────
			// Hidden entirely when the master switch is off — nothing to
			// say and nothing to do. The container is rebuilt by
			// _updateStatus on every poll tick so the runtime state
			// (running / paused / unexpectedly-stopped) and its action
			// toolbar follow the service.
			E('div', {
				'id': 'prism-runtime-section',
				'class': 'cbi-section',
				'style': status.enabled ? '' : 'display:none;'
			}, this._renderRuntime(status, active, subCount, info.rulesLabel, mode)),

			// ── Traffic ────────────────────────────────────────────────
			// One-row digest of /connections from the daemon snapshot:
			// instantaneous bytes/sec each way (10s-averaged), open
			// connection count, and cumulative totals since sing-box
			// started. Hidden when clash API is off; container is always
			// present so _updateClashStats can flip it back on without a
			// page re-render.
			E('div', {
				'id': 'prism-traffic-section',
				'class': 'cbi-section',
				'style': (status.running && statsData && !statsData.error) ? '' : 'display:none;'
			}, this._renderTraffic(statsData)),

			// ── Active groups ──────────────────────────────────────────
			// One row per urltest/selector group, showing the currently
			// active member (clash `now`), its last-known latency, and
			// the group's own tuning (interval/tolerance for urltest,
			// "selector" for manual). Hidden when clash API is off, when
			// the daemon has nothing yet, or when there are no groups —
			// the container is always present so _updateGroups can flip
			// visibility without re-rendering the page.
			E('div', {
				'id': 'prism-groups-section',
				'class': 'cbi-section',
				'style': (Array.isArray(groupsData.groups) && groupsData.groups.length) ? '' : 'display:none;'
			}, this._renderGroups(groupsData)),

			// ── Recent activity ────────────────────────────────────────
			// Two stacked boxes — Prism control-plane events (sparse) and
			// sing-box service log (verbose). Each is a fixed-row textarea,
			// no vertical scroll; long lines still scroll horizontally. The
			// cleanLogLine pass trims each line to "YYYY/MM/DD HH:MM:SS <msg>"
			// so the visible width fits comfortably.
			E('div', { 'class': 'cbi-section' }, [
				E('h4', { 'style': 'margin:0.4em 0 0.3em;' }, [ _('Prism log') ]),
				E('textarea', {
					'id': 'prism-log-prism',
					'class': 'cbi-input-textarea',
					'readonly': 'readonly',
					'wrap': 'off',
					'rows': String(TAIL_LINES),
					'style': 'width:100%; resize:none; overflow-y:hidden; ' +
					         'font-family:monospace; font-size:0.8em; ' +
					         'line-height:1.35; background:rgba(128,128,128,0.05);'
				}, [ prismText ]),
				E('h4', { 'style': 'margin:1em 0 0.3em;' }, [ _('sing-box log') ]),
				E('textarea', {
					'id': 'prism-log-singbox',
					'class': 'cbi-input-textarea',
					'readonly': 'readonly',
					'wrap': 'off',
					'rows': String(TAIL_LINES),
					'style': 'width:100%; resize:none; overflow-y:hidden; ' +
					         'font-family:monospace; font-size:0.8em; ' +
					         'line-height:1.35; background:rgba(128,128,128,0.05);'
				}, [ singboxText ]),
				E('div', { 'style': 'margin:0.5em 0 2em; display:flex; gap:0.4em;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-neutral',
						'click': ui.createHandlerFn(self, '_showFullLog')
					}, [ _('View full log') ]),
					E('button', {
						'class': 'btn cbi-button cbi-button-neutral',
						'click': ui.createHandlerFn(self, '_showConfig')
					}, [ _('View generated config') ])
				])
			]),

		]);

		// Polling and scroll-to-bottom both have to wait until the panel's
		// DOM is actually attached: render() builds a detached node and
		// the host shell (main.js) appends it in a .then microtask after
		// we return. requestAnimationFrame fires after that microtask, so
		// at this point document.getElementById can finally see our IDs.
		// Without this, _scheduleStatusRefresh's "is the panel mounted?"
		// guard short-circuits the initial call and polling never starts
		// on a fresh page load — only the user-action paths
		// (handleStart/Stop/Restart/ToggleEnabled call _refreshStatusNow
		// which then schedules) would resurrect it, which is why the
		// freeze was easy to miss before live traffic numbers made it
		// visible.
		requestAnimationFrame(L.bind(function() {
			this._scheduleStatusRefresh();
			this._scheduleLogRefresh();
			['prism-log-prism', 'prism-log-singbox'].forEach(function(id) {
				var el = document.getElementById(id);
				if (el) el.scrollTop = el.scrollHeight;
			});
		}, this));

		return node;
	},

	// ── Renderers ─────────────────────────────────────────────────────────

	// Three runtime states: 'running' (sing-box up), 'paused' (user clicked
	// Stop, marker present), 'stopped' (down without a marker — typically
	// a crash that exhausted procd respawn before the watchdog re-armed).
	_runtimeState: function(status) {
		if (status.running) return 'running';
		if (status.paused)  return 'paused';
		return 'stopped';
	},

	_renderBadge: function(state) {
		// Plain colored text rather than a `label-*` pill — pills are sized
		// for inline form labels and look cramped at the status row.
		var spec = {
			running: { color: '#26a65b', text: _('● Running') },
			paused:  { color: '#888',    text: _('○ Paused')  },
			stopped: { color: '#dc3545', text: _('● Stopped') }
		}[state];
		return E('span', {
			'style': 'color:' + spec.color + '; font-weight:bold;'
		}, [ spec.text ]);
	},

	_renderFooter: function(status, mode) {
		// Autostart used to live here as a read-out of `enabled`; with the
		// Enable toggle now the visible control for that flag, the footer
		// would just echo it. Mode + version stay — they're not
		// duplicated elsewhere on the page.
		return _('%s · Mode: %s').format(shortVersion(status.version), mode);
	},

	_renderActions: function(state) {
		// running → Stop + Restart
		// paused  → Start + Restart (Start clears the marker)
		// stopped → Start + Restart (recover an unexpectedly-down service)
		if (state === 'running') {
			return [
				E('button', {
					'class': 'btn cbi-button cbi-button-remove',
					'click': ui.createHandlerFn(this, 'handleStop')
				}, [ _('Stop') ]),
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, 'handleRestart')
				}, [ _('Restart') ])
			];
		}
		return [
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'handleStart')
			}, [ _('Start') ]),
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': ui.createHandlerFn(this, 'handleRestart')
			}, [ _('Restart') ])
		];
	},

	_renderEnable: function(enabled) {
		// A plain checkbox + label, big enough that "is Prism turned on?"
		// is a glance question. ui.createHandlerFn binds `this` and the
		// notification-on-error wrapping is shared with the runtime
		// handlers.
		var cb = E('input', {
			'type': 'checkbox',
			'id': 'prism-enable-checkbox',
			'class': 'cbi-input-checkbox',
			'style': 'width:1.2em; height:1.2em; margin:0;',
			'click': ui.createHandlerFn(this, 'handleToggleEnabled')
		});
		if (enabled) cb.checked = true;
		return [
			cb,
			E('label', {
				'for': 'prism-enable-checkbox',
				'style': 'font-size:1.15em; font-weight:bold; cursor:pointer; margin:0;'
			}, [ _('Enable Prism') ]),
			E('span', { 'style': 'opacity:0.6; font-size:0.9em;' }, [
				enabled
					? _('— sing-box runs and autostarts at boot')
					: _('— installed but dormant; no service, no autostart')
			])
		];
	},

	// Compact latency badge, mirroring the nodes panel's colour bands
	// (the constants there are private to that module; the bands are
	// repeated here verbatim because shipping a shared utils module just
	// for one function isn't worth a new require for the status page).
	_renderLatency: function(ms) {
		if (typeof ms !== 'number' || ms <= 0)
			return E('span', { 'style': 'opacity:0.5;' }, [ '—' ]);
		var cls = 'label-success';
		if (ms >= 800)      cls = 'label-danger';
		else if (ms >= 300) cls = 'label-warning';
		return E('span', {
			'class': cls,
			'style': 'padding:1px 6px; border-radius:3px; font-size:0.85em;'
		}, [ ms + 'ms' ]);
	},

	// "urltest · every 1m0s · ±50ms" / "selector → default: HK-01" / "selector"
	// — surfaces the configured tuning right next to the evidence of it
	// churning, so the user can read both at once without leaving the page.
	_renderGroupMeta: function(g) {
		if (g.type === 'urltest') {
			var parts = [ _('urltest') ];
			if (g.interval && g.interval !== '')
				parts.push(_('every %s').format(g.interval));
			if (g.tolerance && g.tolerance !== '')
				parts.push('±' + g.tolerance + 'ms');
			return parts.join(' · ');
		}
		if (g.type === 'selector') {
			if (g.default && g.default !== '')
				return _('selector · default: %s').format(g.default);
			return _('selector');
		}
		return g.type || '';
	},

	// One-line traffic digest. Four columns rendered as inline pieces, not
	// a table — they're a *single* reading at a moment in time, not a
	// growing list. Each piece is id'd so _updateClashStats can refresh
	// the values in place without rebuilding the row (avoids a layout
	// flicker every 2s).
	_renderTraffic: function(stats) {
		stats = stats || {};
		var hasMem = (typeof stats.mem_inuse === 'number' && stats.mem_inuse > 0);
		var pieces = [
			E('span', {}, [
				E('span', { 'style': 'opacity:0.6;' }, [ '↓ ' ]),
				E('strong', { 'id': 'prism-traffic-down' }, [ formatRate(stats.down_bps) ])
			]),
			E('span', {}, [
				E('span', { 'style': 'opacity:0.6;' }, [ '↑ ' ]),
				E('strong', { 'id': 'prism-traffic-up' }, [ formatRate(stats.up_bps) ])
			]),
			E('span', { 'style': 'opacity:0.7;' }, [
				E('span', { 'id': 'prism-traffic-conns' }, [ String(stats.conn_count || 0) ]),
				' ', _('connections')
			]),
			E('span', { 'style': 'opacity:0.7;' }, [
				_('session:'), ' ',
				E('span', { 'id': 'prism-traffic-total-down' }, [ formatBytes(stats.total_down) ]),
				' ↓ / ',
				E('span', { 'id': 'prism-traffic-total-up' }, [ formatBytes(stats.total_up) ]),
				' ↑'
			])
		];
		if (hasMem) {
			pieces.push(E('span', { 'style': 'opacity:0.7;' }, [
				_('memory:'), ' ',
				E('span', { 'id': 'prism-traffic-mem' }, [ formatBytes(stats.mem_inuse) ])
			]));
		}
		return [
			E('h4', { 'style': 'margin:0.2em 0 0.4em;' }, [ _('Traffic') ]),
			E('div', {
				'style': 'display:flex; flex-wrap:wrap; gap:1.2em; ' +
				         'align-items:baseline; font-size:0.95em;'
			}, pieces)
		];
	},

	// Render every group as one row of a compact section table. The empty
	// case (no groups, clash API off, daemon hasn't primed the snapshot
	// yet) returns a single message row so the panel never collapses to
	// nothing once it's been shown — the caller hides the whole section
	// when there are no groups, so this branch is only seen mid-flip.
	_renderGroups: function(data) {
		// luci.jsonc can't tell empty arrays from empty objects at the Lua
		// boundary — an empty `out = {}` in get_active_groups serializes
		// as `{}`, which arrives here as an object, not an array. The
		// section is hidden in that case anyway, but _renderGroups is
		// still invoked to build the contents; coerce defensively so the
		// `.forEach` below doesn't blow up the whole tab.
		var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
		var rows = [];
		var self = this;
		groups.forEach(function(g) {
			rows.push(E('tr', { 'class': 'tr cbi-section-table-row' }, [
				E('td', { 'class': 'td', 'style': 'font-weight:bold;' }, [ g.tag ]),
				E('td', { 'class': 'td', 'style': 'opacity:0.6;' }, [ '→' ]),
				E('td', { 'class': 'td' }, [ g.now || E('span', { 'style': 'opacity:0.5;' }, [ '—' ]) ]),
				E('td', { 'class': 'td' }, [ self._renderLatency(g.delay_ms) ]),
				E('td', {
					'class': 'td',
					'style': 'font-size:0.85em; opacity:0.7;'
				}, [ self._renderGroupMeta(g) ])
			]));
		});
		if (rows.length === 0) {
			rows.push(E('tr', { 'class': 'tr cbi-section-table-row' }, [
				E('td', {
					'class': 'td',
					'colspan': '5',
					'style': 'opacity:0.6; font-style:italic;'
				}, [
					(data && data.error)
						? _('Active-node tracking is disabled — enable the clash API in Settings to see this.')
						: _('No groups configured yet, or daemon still priming.')
				])
			]));
		}
		return [
			E('h4', { 'style': 'margin:0.2em 0 0.4em;' }, [ _('Groups') ]),
			E('table', {
				'class': 'table cbi-section-table',
				'id': 'prism-groups-table'
			}, [
				E('tbody', {}, rows)
			])
		];
	},

	_renderRuntime: function(status, active, subCount, rulesLabel, mode) {
		// The whole runtime section (badge row, counts, footer). Called
		// from render() to build the initial DOM, and again from
		// _updateStatus when the enable state flips on so the contents
		// appear without a full re-render.
		var state = this._runtimeState(status);
		return [
			E('div', {
				'style': 'display:flex; flex-wrap:wrap; align-items:center; ' +
				         'gap:0.7em; padding:0.2em 0; font-size:1.15em; line-height:1.3;'
			}, [
				E('span', { 'id': 'prism-status-badge' }, [
					this._renderBadge(state)
				]),
				E('span', { 'style': 'opacity:0.6; font-weight:normal;' }, [
					_('via')
				]),
				E('strong', { 'id': 'prism-active-node' }, [
					active || _('— no default')
				]),
				E('span', {
					'id': 'prism-status-actions',
					'style': 'margin-left:auto; display:flex; gap:0.3em; font-size:0.88em;'
				}, this._renderActions(state))
			]),
			E('div', {
				'id': 'prism-status-pausenote',
				'style': state === 'paused'
					? 'margin-top:0.4em; font-size:0.9em; opacity:0.7;'
					: 'display:none;'
			}, [ _('Paused for testing — will resume on next reboot.') ]),
			E('div', { 'style': 'margin-top:0.5em;' }, [
				_('Subscriptions: %d').format(subCount),
				' · ',
				rulesLabel
			]),
			E('div', {
				'id': 'prism-status-footer',
				'style': 'margin-top:0.25em;'
			}, [
				this._renderFooter(status, mode)
			])
		];
	},

	// ── Status controls + polling ─────────────────────────────────────────

	handleToggleEnabled: function(ev) {
		var self = this;
		var cb = document.getElementById('prism-enable-checkbox');
		var on = !!(cb && cb.checked);
		return callSetEnabled(on).then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p',
					on ? _('Enable failed — check the log below.')
					   : _('Disable failed — check the log below.')), 'error');
			} else {
				ui.addNotification(null, E('p',
					on ? _('Prism enabled.') : _('Prism disabled.')), 'info');
			}
			return self._refreshStatusNow();
		});
	},

	handleStart: function() {
		var self = this;
		return callStart().then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p', _('Start failed — check the log below.')), 'error');
			} else {
				ui.addNotification(null, E('p', _('Service started.')), 'info');
			}
			return self._refreshStatusNow();
		});
	},

	handleStop: function() {
		var self = this;
		return callStop().then(function() {
			ui.addNotification(null, E('p',
				_('Service stopped — will resume on next reboot.')), 'info');
			return self._refreshStatusNow();
		});
	},

	handleRestart: function() {
		var self = this;
		return callRestart().then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p', _('Restart failed — check the log below.')), 'error');
			} else {
				ui.addNotification(null, E('p', _('Service restarted.')), 'info');
			}
			return self._refreshStatusNow();
		});
	},

	_updateStatus: function(status) {
		// Cached for _updateClashStats so the Traffic row stays hidden
		// whenever sing-box isn't actually running — the daemon snapshot
		// is a tmpfs file that doesn't clear when the service stops.
		this._running = !!status.running;

		// Reflect any out-of-band change to `enabled` (a CLI `uci set`, a
		// concurrent admin) into the checkbox state. Don't fire the click
		// handler — that would loop back into set_enabled.
		var cb = document.getElementById('prism-enable-checkbox');
		if (cb) cb.checked = !!status.enabled;

		// Show/hide the runtime section as a whole. When flipping from
		// disabled→enabled, the section was previously hidden but its
		// inner DOM is still the stale snapshot from render(); rebuild it
		// from current values so the badge/actions/footer match.
		var runtime = document.getElementById('prism-runtime-section');
		if (runtime) {
			if (status.enabled) {
				runtime.style.display = '';
				if (!document.getElementById('prism-status-badge')) {
					var info     = runtimeInfo(this._outbounds);
					var active   = info.active;
					var mode     = uci.get('prism', 'inbounds', 'mode') || 'tproxy';
					var subCount = uci.sections('prism', 'subscription').length;
					while (runtime.firstChild) runtime.removeChild(runtime.firstChild);
					this._renderRuntime(status, active, subCount, info.rulesLabel, mode)
						.forEach(function(n) { runtime.appendChild(n); });
					return;
				}
			} else {
				runtime.style.display = 'none';
				return;
			}
		}

		var state = this._runtimeState(status);

		var badge = document.getElementById('prism-status-badge');
		if (badge) {
			while (badge.firstChild) badge.removeChild(badge.firstChild);
			badge.appendChild(this._renderBadge(state));
		}
		var actions = document.getElementById('prism-status-actions');
		if (actions) {
			while (actions.firstChild) actions.removeChild(actions.firstChild);
			this._renderActions(state).forEach(function(b) {
				actions.appendChild(b);
			});
		}
		var pausenote = document.getElementById('prism-status-pausenote');
		if (pausenote) {
			pausenote.style.display = (state === 'paused') ? '' : 'none';
			if (state === 'paused') {
				pausenote.style.marginTop = '0.4em';
				pausenote.style.fontSize  = '0.9em';
				pausenote.style.opacity   = '0.7';
			}
		}
		var footer = document.getElementById('prism-status-footer');
		if (footer) {
			var mode2 = uci.get('prism', 'inbounds', 'mode') || 'tproxy';
			footer.textContent = this._renderFooter(status, mode2);
		}
	},

	// Replace the Groups section's rows with the new snapshot. Hides the
	// whole section when the snapshot is empty so the page collapses
	// quietly back to the no-groups layout if the user deletes their last
	// group (or turns clash API off) without reloading the tab.
	_updateGroups: function(data) {
		var section = document.getElementById('prism-groups-section');
		if (!section) return;
		var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
		section.style.display = (groups.length > 0) ? '' : 'none';
		if (groups.length === 0) return;
		while (section.firstChild) section.removeChild(section.firstChild);
		this._renderGroups(data).forEach(function(n) {
			section.appendChild(n);
		});
	},

	// In-place refresh of the four (or five, with memory) traffic spans.
	// Re-renders the whole row only when the memory pill needs to appear
	// or disappear — adding/removing a sibling mid-row would otherwise
	// shift the others, and gating just that one span by display:none on
	// every tick is cheap. Hides the whole section when clash API was
	// disabled at runtime (Settings flipped while we were watching).
	_updateClashStats: function(stats) {
		var section = document.getElementById('prism-traffic-section');
		if (!section) return;
		stats = stats || {};
		// Show only when the clash API is on AND sing-box is currently
		// up — a stale snapshot from a stopped sing-box is worse than
		// silence. `_running` is set by _updateStatus on each tick;
		// undefined on the first call (load() already gated the initial
		// render).
		if (stats.error || this._running === false) {
			section.style.display = 'none';
			return;
		}
		section.style.display = '';
		var memEl  = document.getElementById('prism-traffic-mem');
		var wantMem = (typeof stats.mem_inuse === 'number' && stats.mem_inuse > 0);
		if (wantMem !== !!memEl) {
			while (section.firstChild) section.removeChild(section.firstChild);
			this._renderTraffic(stats).forEach(function(n) { section.appendChild(n); });
			return;
		}
		var set = function(id, text) {
			var el = document.getElementById(id);
			if (el) el.textContent = text;
		};
		set('prism-traffic-down',       formatRate(stats.down_bps));
		set('prism-traffic-up',         formatRate(stats.up_bps));
		set('prism-traffic-conns',      String(stats.conn_count || 0));
		set('prism-traffic-total-down', formatBytes(stats.total_down));
		set('prism-traffic-total-up',   formatBytes(stats.total_up));
		if (wantMem) set('prism-traffic-mem', formatBytes(stats.mem_inuse));
	},

	_refreshStatusNow: function() {
		var self = this;
		return Promise.all([
			callGetStatus().catch(function() { return {}; }),
			callGetActiveGroups().catch(function() { return { groups: [] }; }),
			callGetClashStats().catch(function() { return {}; })
		]).then(function(r) {
			self._updateStatus(r[0] || {});
			self._updateGroups(r[1] || { groups: [] });
			self._updateClashStats(r[2] || {});
			self._scheduleStatusRefresh();
		});
	},

	_scheduleStatusRefresh: function() {
		// Bail if the tab's DOM is gone (switched away) so a stray in-flight
		// poll cannot resurrect the timer after _teardown.
		if (!document.getElementById('prism-status-badge'))
			return;
		if (this._statusTimer)
			clearTimeout(this._statusTimer);
		this._statusTimer = setTimeout(L.bind(function() {
			// Fan out both reads in parallel so the tick still fits the
			// 2s budget even when one side stalls. The active-groups read
			// is a cheap file read on the daemon's tmpfs snapshot, so the
			// extra round trip is negligible.
			Promise.all([
				callGetStatus().catch(function() { return {}; }),
				callGetActiveGroups().catch(function() { return { groups: [] }; }),
				callGetClashStats().catch(function() { return {}; })
			]).then(L.bind(function(r) {
				this._updateStatus(r[0] || {});
				this._updateGroups(r[1] || { groups: [] });
				this._updateClashStats(r[2] || {});
			}, this))
				.catch(function() {})
				.finally(L.bind(this._scheduleStatusRefresh, this));
		}, this), POLL_MS);
	},

	// ── Log tail polling ──────────────────────────────────────────────────

	_refreshLogTail: function() {
		return callGetLogs(TAIL_LINES).then(function(data) {
			data = data || {};
			[['prism-log-prism', data.prism],
			 ['prism-log-singbox', data.singbox]].forEach(function(pair) {
				var el = document.getElementById(pair[0]);
				if (!el) return;
				el.value = formatLog(pair[1]);
				el.scrollTop = el.scrollHeight;
			});
		});
	},

	_scheduleLogRefresh: function() {
		if (this._logTimer)
			clearTimeout(this._logTimer);
		if (!document.getElementById('prism-log-singbox')) return;
		this._logTimer = setTimeout(L.bind(function() {
			this._refreshLogTail()
				.catch(function() {})
				.finally(L.bind(this._scheduleLogRefresh, this));
		}, this), POLL_MS);
	},

	// ── Modals ────────────────────────────────────────────────────────────

	_showFullLog: function() {
		ui.showModal(_('Service log'), [
			E('div', { 'class': 'spinning' }, [ _('Loading…') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
			])
		]);
		return callGetLog(FULL_LOG_LINES).then(function(data) {
			var lines = formatLog(data && data.log);
			var ta = E('textarea', {
				'class': 'cbi-input-textarea',
				'readonly': 'readonly',
				'wrap': 'off',
				'style': 'width:100%; height:60vh; font-family:monospace; ' +
				         'font-size:0.8em; line-height:1.35;'
			}, [ lines ]);
			ui.showModal(_('Service log (last %d lines)').format(FULL_LOG_LINES), [
				ta,
				E('div', { 'class': 'right', 'style': 'margin-top:0.5em;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
				])
			]);
			// Defer scroll until the modal is mounted; without this the
			// scrollHeight is read before layout completes.
			requestAnimationFrame(function() { ta.scrollTop = ta.scrollHeight; });
		}).catch(function() {
			ui.showModal(_('Service log'), [
				E('p', {}, [ _('Failed to load the log.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
				])
			]);
		});
	},

	_showConfig: function() {
		ui.showModal(_('Generated configuration'), [
			E('div', { 'class': 'spinning' }, [ _('Loading…') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
			])
		]);
		return callGetConfig().then(function(data) {
			data = data || {};
			var path = data.path || '/var/etc/prism/sing-box.json';
			var json = data.json || '';
			var content = [
				E('div', { 'style': 'display:flex; align-items:center; gap:0.5em; margin-bottom:0.4em; flex-wrap:wrap;' }, [
					E('span', { 'style': 'font-size:0.85em; opacity:0.7;' }, [ _('Target file:') ]),
					E('code', { 'style': 'font-size:0.85em;' }, [ path ]),
					data.exists
						? E('span', { 'class': 'label-success', 'style': 'padding:1px 7px; border-radius:3px;' }, [ _('running file present') ])
						: E('span', { 'class': 'label-warning', 'style': 'padding:1px 7px; border-radius:3px;' }, [ _('preview only — not yet applied') ])
				])
			];
			if (data.error)
				content.push(E('div', { 'class': 'alert-message warning', 'style': 'margin-bottom:0.4em; font-size:0.85em;' }, [
					E('strong', {}, [ _('Generator error:') ]), ' ',
					E('code', {}, [ data.error ])
				]));
			content.push(E('textarea', {
				'class': 'cbi-input-textarea',
				'readonly': 'readonly',
				'spellcheck': 'false',
				'style': 'width:100%; height:60vh; font-family:monospace; ' +
				         'font-size:0.8em; line-height:1.4; background:rgba(128,128,128,0.05);'
			}, [ json ]));
			content.push(E('div', { 'style': 'margin-top:0.5em; display:flex; justify-content:space-between; gap:0.4em;' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'disabled': json ? null : 'disabled',
					'click': function() { downloadConfig(json); }
				}, [ _('Download config') ]),
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
			]));
			ui.showModal(_('Generated configuration'), content);
		}).catch(function() {
			ui.showModal(_('Generated configuration'), [
				E('p', {}, [ _('Failed to load the generated config.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
				])
			]);
		});
	},

	// Called by the host shell when this panel's tab is switched away.
	_teardown: function() {
		if (this._statusTimer) {
			clearTimeout(this._statusTimer);
			this._statusTimer = null;
		}
		if (this._logTimer) {
			clearTimeout(this._logTimer);
			this._logTimer = null;
		}
	},

	handleSave:      null,
	handleSaveApply: null,
	handleReset:     null
});

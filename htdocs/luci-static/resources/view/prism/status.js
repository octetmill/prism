// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Status tab: the dashboard. Answers "is it working?" at a glance and "why
// not?" without leaving the page.
//
// Layout (top → bottom):
//   ● Running/Stopped  via  <active-server>   [Stop] [Restart]
//   Subscriptions: N · Active rules: N
//   <recent activity — 20-line log tail, auto-refreshed>
//   [View full log] [View generated config]
//   sing-box X.Y.Z · Autostart · Mode
//
// Restart on a stopped service just calls start, so no separate Start button
// is needed — Stop and Restart cover every transition.
//
// Two 2s pollers — one for service status (badge + autostart), one for the
// log tail. Both are torn down on tab switch via _teardown. The full log
// viewer and the generated-config preview live in on-demand modals (the
// prior Diagnostics panel rendered them inline; here they would crowd the
// glance-first layout).
//
// The active-server line shows `routing.final_outbound` from UCI — the tag
// of the default group/server the rule chain falls through to. This commit
// shows it read-only; a follow-up may turn it into an inline group switcher.

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

var TAIL_LINES   = 20;
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
		// All three degrade gracefully — a missing RPC leaves the relevant
		// row blank rather than blanking the tab. get_logs returns
		// { prism: [...], singbox: [...] }; ask for the larger of the two
		// caps so both boxes can fill independently.
		return Promise.all([
			callGetStatus().catch(function() { return {}; }),
			callGetLogs(TAIL_LINES).catch(function() { return {}; }),
			uci.load('prism').catch(function() { return null; })
		]);
	},

	render: function(results) {
		var status     = (results && results[0]) || {};
		var logsData   = (results && results[1]) || {};
		var prismText  = formatLog(logsData.prism);
		var singboxText = formatLog(logsData.singbox);

		var active = uci.get('prism', 'routing', 'final_outbound') || '';
		var mode   = uci.get('prism', 'inbounds', 'mode') || 'tproxy';
		var subCount = uci.sections('prism', 'subscription').length;
		var ruleCount = uci.sections('prism', 'rule').filter(function(r) {
			return r.enabled !== '0';
		}).length;

		var self = this;

		var node = E('div', { 'class': 'cbi-map' }, [

			// ── Status row ─────────────────────────────────────────────
			// One big colored line — large enough that "is it working?" is
			// answerable from across the room. Restart on a stopped service
			// just starts it, so no separate Start button — Stop and Restart
			// cover every transition.
			E('div', { 'class': 'cbi-section' }, [
				E('div', {
					'style': 'display:flex; flex-wrap:wrap; align-items:center; ' +
					         'gap:0.7em; padding:0.2em 0; font-size:1.45em; line-height:1.3;'
				}, [
					E('span', { 'id': 'prism-status-badge' }, [
						this._renderBadge(status.running)
					]),
					E('span', { 'style': 'opacity:0.6; font-weight:normal;' }, [
						_('via')
					]),
					E('strong', { 'id': 'prism-active-server' }, [
						active || _('— no default')
					]),
					E('span', { 'style': 'margin-left:auto; display:flex; gap:0.3em; font-size:0.7em;' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'click': ui.createHandlerFn(self, 'handleStop')
						}, [ _('Stop') ]),
						E('button', {
							'class': 'btn cbi-button cbi-button-neutral',
							'click': ui.createHandlerFn(self, 'handleRestart')
						}, [ _('Restart') ])
					])
				]),
				E('div', {
					'style': 'margin-top:0.5em;'
				}, [
					_('Subscriptions: %d').format(subCount),
					' · ',
					_('Active rules: %d').format(ruleCount)
				]),
				E('div', {
					'id': 'prism-status-footer',
					'style': 'margin-top:0.25em;'
				}, [
					this._renderFooter(status, mode)
				])
			]),

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
				E('div', { 'style': 'margin-top:0.5em; display:flex; gap:0.4em;' }, [
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

		this._scheduleStatusRefresh();
		this._scheduleLogRefresh();
		// Initial scroll-to-bottom for the rare case where lines wrap onto
		// more rows than the box can show; deferred so the textareas are in
		// the DOM (and have their scrollHeight) by the time we read them.
		requestAnimationFrame(function() {
			['prism-log-prism', 'prism-log-singbox'].forEach(function(id) {
				var el = document.getElementById(id);
				if (el) el.scrollTop = el.scrollHeight;
			});
		});

		return node;
	},

	// ── Renderers ─────────────────────────────────────────────────────────

	_renderBadge: function(running) {
		// Plain colored text rather than a `label-*` pill — pills are sized
		// for inline form labels and look cramped at the 1.45em status row.
		var color = running ? '#26a65b' : '#dc3545';
		return E('span', {
			'style': 'color:' + color + '; font-weight:bold;'
		}, [ running ? _('● Running') : _('● Stopped') ]);
	},

	_renderFooter: function(status, mode) {
		var autostart = status.enabled ? _('on') : _('off');
		return _('%s · Autostart: %s · Mode: %s').format(
			shortVersion(status.version), autostart, mode);
	},

	// ── Status controls + polling ─────────────────────────────────────────

	handleStop: function() {
		var self = this;
		return callStop().then(function() {
			ui.addNotification(null, E('p', _('Service stopped.')), 'info');
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
		var badge = document.getElementById('prism-status-badge');
		if (badge) {
			while (badge.firstChild) badge.removeChild(badge.firstChild);
			badge.appendChild(this._renderBadge(status.running));
		}
		var footer = document.getElementById('prism-status-footer');
		if (footer) {
			var mode = uci.get('prism', 'inbounds', 'mode') || 'tproxy';
			footer.textContent = this._renderFooter(status, mode);
		}
	},

	_refreshStatusNow: function() {
		var self = this;
		return callGetStatus().then(function(s) {
			self._updateStatus(s || {});
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
			callGetStatus().then(L.bind(this._updateStatus, this))
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

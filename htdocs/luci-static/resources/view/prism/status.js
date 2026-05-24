// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Status tab: the dashboard. Answers "is it working?" at a glance and "why
// not?" without leaving the page.
//
// Layout (top → bottom):
//   ● Running/Stopped  via  <active-server>   [Start|Stop] [Restart]
//   Subscriptions: N · Active rules: N
//   <recent activity — 20-line log tail, auto-refreshed>
//   [View full log] [View generated config]
//   sing-box X.Y.Z · Autostart · Mode
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

var callGetConfig = rpc.declare({
	object: 'luci.prism',
	method: 'get_config',
	expect: { '': {} }
});

var TAIL_LINES = 20;
var POLL_MS    = 2000;
var FULL_LOG_LINES = 500;

return baseclass.extend({
	_statusTimer: null,
	_logTimer:    null,

	load: function() {
		// All three degrade gracefully — a missing RPC leaves the relevant
		// row blank rather than blanking the tab.
		return Promise.all([
			callGetStatus().catch(function() { return {}; }),
			callGetLog(TAIL_LINES).catch(function() { return {}; }),
			uci.load('prism').catch(function() { return null; })
		]);
	},

	render: function(results) {
		var status   = (results && results[0]) || {};
		var logData  = (results && results[1]) || {};
		var logLines = (Array.isArray(logData.log) ? logData.log : []).join('\n');

		var active = uci.get('prism', 'routing', 'final_outbound') || '';
		var mode   = uci.get('prism', 'inbounds', 'mode') || 'tproxy';
		var subCount = uci.sections('prism', 'subscription').length;
		var ruleCount = uci.sections('prism', 'rule').filter(function(r) {
			return r.enabled !== '0';
		}).length;

		var self = this;

		var node = E('div', { 'class': 'cbi-map' }, [

			// ── Status row ─────────────────────────────────────────────
			E('div', { 'class': 'cbi-section' }, [
				E('div', {
					'style': 'display:flex; flex-wrap:wrap; align-items:center; ' +
					         'gap:0.9em; padding:0.2em 0;'
				}, [
					E('span', { 'id': 'prism-status-badge', 'style': 'font-size:1.05em;' }, [
						this._renderBadge(status.running)
					]),
					E('span', { 'style': 'font-size:0.95em;' }, [
						_('via') + ' ',
						E('strong', { 'id': 'prism-active-server' }, [
							active || _('— no default')
						])
					]),
					E('span', { 'style': 'margin-left:auto; display:flex; gap:0.3em;' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-apply',
							'click': ui.createHandlerFn(self, 'handleStart')
						}, [ _('Start') ]),
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
					'style': 'margin-top:0.5em; font-size:0.85em; opacity:0.75;'
				}, [
					_('Subscriptions: %d').format(subCount),
					' · ',
					_('Active rules: %d').format(ruleCount)
				])
			]),

			// ── Recent activity ────────────────────────────────────────
			E('div', { 'class': 'cbi-section' }, [
				E('h3', { 'style': 'margin-bottom:0.4em;' }, [ _('Recent activity') ]),
				E('textarea', {
					'id': 'prism-log-tail',
					'class': 'cbi-input-textarea',
					'readonly': 'readonly',
					'wrap': 'off',
					'style': 'width:100%; height:21em; resize:vertical; ' +
					         'font-family:monospace; font-size:0.8em; ' +
					         'line-height:1.35; background:rgba(128,128,128,0.05);'
				}, [ logLines ]),
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

			// ── Footer line ────────────────────────────────────────────
			E('div', {
				'id': 'prism-status-footer',
				'style': 'margin:0.5em 0.5em; font-size:0.8em; opacity:0.6;'
			}, [
				this._renderFooter(status, mode)
			])
		]);

		this._scheduleStatusRefresh();
		this._scheduleLogRefresh();
		// Initial scroll-to-end is deferred so the textarea is in the DOM
		// (and has its scrollHeight) by the time we read it.
		requestAnimationFrame(function() {
			var el = document.getElementById('prism-log-tail');
			if (el) el.scrollTop = el.scrollHeight;
		});

		return node;
	},

	// ── Renderers ─────────────────────────────────────────────────────────

	_renderBadge: function(running) {
		return running
			? E('span', { 'class': 'label-success' }, [ _('● Running') ])
			: E('span', { 'class': 'label-warning' }, [ _('● Stopped') ]);
	},

	_renderFooter: function(status, mode) {
		var version = status.version || _('unknown version');
		var autostart = status.enabled ? _('on') : _('off');
		return _('sing-box %s · Autostart: %s · Mode: %s').format(version, autostart, mode);
	},

	// ── Status controls + polling ─────────────────────────────────────────

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
		return callGetLog(TAIL_LINES).then(L.bind(function(data) {
			var el = document.getElementById('prism-log-tail');
			if (!el) return;
			el.value = (Array.isArray(data.log) ? data.log : []).join('\n');
			el.scrollTop = el.scrollHeight;
		}, this));
	},

	_scheduleLogRefresh: function() {
		if (this._logTimer)
			clearTimeout(this._logTimer);
		if (!document.getElementById('prism-log-tail')) return;
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
			var lines = (data && Array.isArray(data.log)) ? data.log.join('\n') : '';
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
			}, [ data.json || '' ]));
			content.push(E('div', { 'class': 'right', 'style': 'margin-top:0.5em;' }, [
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

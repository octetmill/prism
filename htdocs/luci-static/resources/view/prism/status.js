// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Status tab: service controls + recent log + generated-config preview.
// This is a transitional merge of the former Overview and Diagnostics panels —
// the body is unchanged from those two stacked. A follow-up commit replaces it
// with the new compact layout (status row, 20-line log tail, modal config).

'use strict';
'require baseclass';
'require rpc';
'require ui';

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

var callReload = rpc.declare({
	object: 'luci.prism',
	method: 'reload',
	expect: { '': {} }
});

var LINE_OPTIONS = [50, 100, 200, 500];

return baseclass.extend({
	_logTimer:    null,
	_statusTimer: null,
	_lines:       200,

	load: function() {
		// Degrade gracefully — a failed RPC must not blank the whole tab.
		return Promise.all([
			callGetStatus().catch(function() { return {}; }),
			callGetLog(this._lines || 200).catch(function() { return {}; }),
			callGetConfig().catch(function() { return {}; })
		]);
	},

	render: function(results) {
		var status     = (results && results[0]) || {};
		var logData    = (results && results[1]) || {};
		var configData = (results && results[2]) || {};
		var logLines   = (Array.isArray(logData.log) ? logData.log : []).join('\n');
		var configText = configData.json  || '';
		var configPath = configData.path  || '/var/etc/prism/sing-box.json';
		var configHas  = !!configData.exists;
		var configErr  = configData.error || '';

		var self = this;

		var lineSel = E('select', {
			'id': 'prism-log-lines',
			'class': 'cbi-input-select',
			'style': 'padding:0.25em 0.4em; border:1px solid rgba(128,128,128,0.4); border-radius:3px;',
			'change': L.bind(function(ev) {
				this._lines = Number(ev.target.value) || 200;
				this._refreshLog();
			}, this)
		}, LINE_OPTIONS.map(function(n) {
			return E('option', { 'value': String(n), 'selected': n === 200 ? 'selected' : null }, [ String(n) ]);
		}));

		var node = E('div', { 'class': 'cbi-map' }, [

			// --- Service controls (was overview.js) -------------------------
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-descr' }, [
					_('sing-box proxy engine status and controls.')
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, [ _('Status') ]),
					E('div', { 'class': 'cbi-value-field' }, [
						E('span', { 'id': 'prism-status-badge' }, [
							self._renderBadge(status.running)
						]),
						E('span', { 'style': 'margin-left:1em;' }, [
							E('button', {
								'class': 'btn cbi-button cbi-button-apply',
								'style': 'margin-right:0.3em;',
								'click': ui.createHandlerFn(self, 'handleStart')
							}, [ _('Start') ]),
							E('button', {
								'class': 'btn cbi-button cbi-button-remove',
								'style': 'margin-right:0.3em;',
								'click': ui.createHandlerFn(self, 'handleStop')
							}, [ _('Stop') ]),
							E('button', {
								'class': 'btn cbi-button cbi-button-neutral',
								'click': ui.createHandlerFn(self, 'handleRestart')
							}, [ _('Restart') ])
						])
					])
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, [ _('Autostart at boot') ]),
					E('div', { 'class': 'cbi-value-field', 'id': 'prism-autostart-field' }, [
						status.enabled ? _('Yes') : _('No')
					])
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, [ _('Version') ]),
					E('div', { 'class': 'cbi-value-field' }, [
						status.version || _('Unknown')
					])
				])
			]),

			// --- Log section (was diagnostics.js) ---------------------------
			E('div', { 'class': 'cbi-section', 'id': 'prism-log-section' }, [
				E('h3', {}, [ _('Log') ]),
				E('div', { 'class': 'cbi-section-descr' }, [
					_('Tail of the sing-box service log. Refreshes automatically every 3 seconds.')
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('div', { 'class': 'cbi-value-field' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-neutral',
							'click': ui.createHandlerFn(this, this._refreshLog)
						}, [ _('Refresh') ]),
						' \xA0 ',
						E('label', {}, [
							E('input', {
								'type': 'checkbox',
								'id': 'prism-log-autorefresh',
								'checked': 'checked',
								'style': 'margin-right:0.3em',
								'change': L.bind(function(ev) {
									if (ev.target.checked) this._scheduleLogRefresh();
									else if (this._logTimer) {
										clearTimeout(this._logTimer);
										this._logTimer = null;
									}
								}, this)
							}),
							_('Auto-refresh')
						]),
						' \xA0 ',
						E('label', {}, [
							E('input', {
								'type': 'checkbox',
								'id': 'prism-log-autoscroll',
								'checked': 'checked',
								'style': 'margin-right:0.3em'
							}),
							_('Auto-scroll')
						]),
						' \xA0 ',
						_('Lines:'), ' ',
						lineSel
					])
				]),
				E('textarea', {
					'id': 'prism-log-output',
					'class': 'cbi-input-textarea',
					'style': 'width:100%; min-height:400px; font-family:monospace; font-size:0.82em; line-height:1.35;',
					'readonly': 'readonly',
					'wrap': 'off'
				}, [ logLines ])
			]),

			// --- Generated config preview (was diagnostics.js) --------------
			E('div', { 'class': 'cbi-section', 'id': 'prism-cfg-section' }, [
				E('h3', {}, [ _('Generated Configuration') ]),
				E('div', { 'class': 'cbi-section-descr' }, [
					_('Live preview of the JSON Prism would feed to sing-box based on your current saved settings. Built fresh each time this tab loads — click Reload service to push it to the running daemon.')
				]),
				E('div', { 'style': 'display:flex; align-items:center; gap:0.5em; margin-bottom:0.5em; flex-wrap:wrap;' }, [
					E('span', { 'style': 'font-size:0.85em; color:#666;' }, [ _('Target file:') ]),
					E('code', { 'id': 'prism-cfg-path', 'style': 'font-size:0.85em;' }, [ configPath ]),
					configHas
						? E('span', { 'class': 'label-success', 'style': 'padding:1px 7px; border-radius:3px;' }, [ _('running file present') ])
						: E('span', { 'class': 'label-warning', 'style': 'padding:1px 7px; border-radius:3px;' }, [ _('preview only — not yet applied') ])
				]),
				configErr
					? E('div', { 'class': 'alert-message warning', 'style': 'margin-bottom:0.5em; font-size:0.85em;' }, [
						E('strong', {}, [ _('Generator error:') ]),
						' ',
						E('code', {}, [ configErr ])
					])
					: '',
				E('textarea', {
					'id': 'prism-cfg-text',
					'class': 'cbi-input-textarea',
					'style': 'width:100%; min-height:320px; font-family:monospace; font-size:0.82em; line-height:1.4; background:rgba(128,128,128,0.05);',
					'spellcheck': 'false',
					'readonly': 'readonly'
				}, [ configText ])
			]),

			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'style': 'margin-right:0.5em;',
					'id': 'prism-cfg-regen-btn',
					'click': ui.createHandlerFn(this, this._refreshPreview)
				}, [ '↻ ' + _('Refresh preview') ]),
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, this._handleReloadService)
				}, [ '⟳ ' + _('Reload service') ])
			])
		]);

		this._scheduleStatusRefresh();
		this._scheduleLogRefresh();
		requestAnimationFrame(function() {
			var el = document.getElementById('prism-log-output');
			if (el) el.scrollTop = el.scrollHeight;
		});

		return node;
	},

	// ── Service controls ──────────────────────────────────────────────────

	_renderBadge: function(running) {
		return running
			? E('span', { 'class': 'label-success' }, [ _('Running') ])
			: E('span', { 'class': 'label-warning' }, [ _('Stopped') ]);
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

	updateStatus: function(status) {
		var el = document.getElementById('prism-status-badge');
		if (!el) return;
		while (el.firstChild) el.removeChild(el.firstChild);
		el.appendChild(this._renderBadge(status.running));
		// The Start/Stop RPCs flip the autostart flag too, so keep that row
		// in sync rather than letting it go stale until the tab is reopened.
		var as = document.getElementById('prism-autostart-field');
		if (as) as.textContent = status.enabled ? _('Yes') : _('No');
		this._scheduleStatusRefresh();
	},

	_refreshStatusNow: function() {
		return callGetStatus().then(L.bind(this.updateStatus, this));
	},

	_scheduleStatusRefresh: function() {
		// Bail if the panel's DOM is gone (tab switched away) so a failed
		// in-flight poll cannot resurrect the timer after _teardown.
		if (!document.getElementById('prism-status-badge'))
			return;
		if (this._statusTimer)
			clearTimeout(this._statusTimer);
		this._statusTimer = setTimeout(L.bind(function() {
			callGetStatus().then(L.bind(this.updateStatus, this)).catch(L.bind(function() {
				// reschedule even on RPC failure so the loop survives transient errors
				this._scheduleStatusRefresh();
			}, this));
		}, this), 5000);
	},

	// ── Log + config preview ──────────────────────────────────────────────

	_refreshLog: function() {
		return callGetLog(this._lines || 200).then(L.bind(function(data) {
			var el = document.getElementById('prism-log-output');
			if (!el) return;
			el.value = (Array.isArray(data.log) ? data.log : []).join('\n');
			var cb = document.getElementById('prism-log-autoscroll');
			if (cb && cb.checked) el.scrollTop = el.scrollHeight;
			this._scheduleLogRefresh();
		}, this)).catch(L.bind(function() {
			this._scheduleLogRefresh();
		}, this));
	},

	_scheduleLogRefresh: function() {
		if (this._logTimer) {
			clearTimeout(this._logTimer);
			this._logTimer = null;
		}
		var cb = document.getElementById('prism-log-autorefresh');
		if (cb && !cb.checked) return;
		if (!document.getElementById('prism-log-output')) return;
		this._logTimer = setTimeout(L.bind(this._refreshLog, this), 3000);
	},

	_refreshPreview: function() {
		var btn = document.getElementById('prism-cfg-regen-btn');
		if (btn) btn.disabled = true;
		return callGetConfig().then(function(data) {
			data = data || {};
			var ta   = document.getElementById('prism-cfg-text');
			var path = document.getElementById('prism-cfg-path');
			if (ta)   ta.value = data.json || '';
			if (path) path.textContent = data.path || '/var/etc/prism/sing-box.json';
			if (data.error)
				ui.addNotification(null, E('p', _('Generator error: ') + data.error), 'error');
		}).catch(function() {
			ui.addNotification(null, E('p', _('Failed to refresh preview.')), 'error');
		}).finally(function() {
			if (btn) btn.disabled = false;
		});
	},

	_handleReloadService: function() {
		var self = this;
		return callReload().then(function() {
			ui.addNotification(null, E('p', _('Reload signalled.')), 'info');
			return self._refreshPreview();
		}).catch(function() {
			ui.addNotification(null, E('p', _('Reload failed.')), 'error');
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

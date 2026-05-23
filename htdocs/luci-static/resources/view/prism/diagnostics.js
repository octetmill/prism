// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require rpc';
'require ui';

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
	_refreshTimer: null,
	_lines:        200,

	load: function() {
		// Degrade gracefully — a failed RPC must not blank the whole tab.
		return Promise.all([
			callGetLog(this._lines || 200).catch(function() { return {}; }),
			callGetConfig().catch(function() { return {}; })
		]);
	},

	render: function(results) {
		var logData    = (results && results[0]) || {};
		var configData = (results && results[1]) || {};
		var logLines   = (Array.isArray(logData.log) ? logData.log : []).join('\n');
		var configText = configData.json  || '';
		var configPath = configData.path  || '/var/etc/prism/sing-box.json';
		var configHas  = !!configData.exists;
		var configErr  = configData.error || '';

		var lineSel = E('select', {
			'id': 'prism-log-lines',
			'class': 'cbi-input-select',
			'style': 'padding:0.25em 0.4em; border:1px solid rgba(128,128,128,0.4); border-radius:3px;',
			'change': L.bind(function(ev) {
				this._lines = Number(ev.target.value) || 200;
				this._refresh();
			}, this)
		}, LINE_OPTIONS.map(function(n) {
			return E('option', { 'value': String(n), 'selected': n === 200 ? 'selected' : null }, [ String(n) ]);
		}));

		var node = E('div', { 'class': 'cbi-map' }, [

			// --- Log section -------------------------------------------------
			E('div', { 'class': 'cbi-section', 'id': 'prism-log-section' }, [
				E('h3', {}, [ _('Log') ]),
				E('div', { 'class': 'cbi-section-descr' }, [
					_('Tail of the sing-box service log. Refreshes automatically every 3 seconds.')
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('div', { 'class': 'cbi-value-field' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-neutral',
							'click': ui.createHandlerFn(this, this._refresh)
						}, [ _('Refresh') ]),
						' \xA0 ',
						E('label', {}, [
							E('input', {
								'type': 'checkbox',
								'id': 'prism-log-autorefresh',
								'checked': 'checked',
								'style': 'margin-right:0.3em',
								'change': L.bind(function(ev) {
									if (ev.target.checked) this._scheduleRefresh();
									else if (this._refreshTimer) {
										clearTimeout(this._refreshTimer);
										this._refreshTimer = null;
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

			// --- Generated config preview ------------------------------------
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

		this._scheduleRefresh();
		requestAnimationFrame(function() {
			var el = document.getElementById('prism-log-output');
			if (el) el.scrollTop = el.scrollHeight;
		});
		return node;
	},

	_refresh: function() {
		return callGetLog(this._lines || 200).then(L.bind(function(data) {
			var el = document.getElementById('prism-log-output');
			if (!el) return;
			el.value = (Array.isArray(data.log) ? data.log : []).join('\n');
			var cb = document.getElementById('prism-log-autoscroll');
			if (cb && cb.checked) el.scrollTop = el.scrollHeight;
			this._scheduleRefresh();
		}, this)).catch(L.bind(function() {
			this._scheduleRefresh();
		}, this));
	},

	_scheduleRefresh: function() {
		if (this._refreshTimer) {
			clearTimeout(this._refreshTimer);
			this._refreshTimer = null;
		}
		var cb = document.getElementById('prism-log-autorefresh');
		if (cb && !cb.checked) return;
		if (!document.getElementById('prism-log-output')) return;
		this._refreshTimer = setTimeout(L.bind(this._refresh, this), 3000);
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
		if (this._refreshTimer) {
			clearTimeout(this._refreshTimer);
			this._refreshTimer = null;
		}
	},

	handleSave:      null,
	handleSaveApply: null,
	handleReset:     null
});

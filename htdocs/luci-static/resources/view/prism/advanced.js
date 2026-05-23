// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require rpc';
'require ui';

var callGetExtraConfig = rpc.declare({
	object: 'luci.prism',
	method: 'get_extra_config',
	expect: { '': {} }
});

var callSetExtraConfig = rpc.declare({
	object: 'luci.prism',
	method: 'set_extra_config',
	params: ['payload'],
	expect: { '': {} }
});

return baseclass.extend({
	load: function() {
		return callGetExtraConfig().catch(function() { return {}; });
	},

	render: function(extraData) {
		var extraText = (extraData && extraData.json) || '';

		return E('div', { 'class': 'cbi-map' }, [
			E('div', { 'class': 'cbi-section', 'id': 'prism-extra-section' }, [
				E('h3', {}, [ _('Advanced Overrides') ]),
				E('div', { 'class': 'cbi-section-descr' }, [
					_('Optional JSON object stored at /etc/prism/extra.json. Top-level keys here shallow-merge into the generated config (arrays are replaced wholesale). Use sparingly — most settings have a dedicated tab.')
				]),
				E('textarea', {
					'id': 'prism-extra-text',
					'class': 'cbi-input-textarea',
					'style': 'width:100%; min-height:320px; font-family:monospace; font-size:0.82em; line-height:1.4;',
					'spellcheck': 'false',
					'placeholder': '{\n  "experimental": {\n    "clash_api": { "external_controller": "127.0.0.1:9090" }\n  }\n}'
				}, [ extraText ])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-remove',
					'style': 'margin-right:0.5em;',
					'click': ui.createHandlerFn(this, this._handleClearExtra)
				}, [ _('Clear overrides') ]),
				E('button', {
					'class': 'btn cbi-button cbi-button-save',
					'click': ui.createHandlerFn(this, this._handleSaveExtra)
				}, [ _('Save overrides') ])
			])
		]);
	},

	_handleSaveExtra: function() {
		var el = document.getElementById('prism-extra-text');
		if (!el) return;
		var raw = el.value || '';
		if (raw.match(/^\s*$/) === null) {
			try {
				var parsed = JSON.parse(raw);
				if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
					ui.addNotification(null, E('p', _('Overrides must be a JSON object.')), 'error');
					return;
				}
			} catch (e) {
				ui.addNotification(null, E('p', _('Invalid JSON: ') + e.message), 'error');
				return;
			}
		}
		return callSetExtraConfig(raw).then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p', res.error || _('Save failed.')), 'error');
				return;
			}
			ui.addNotification(null, E('p', _('Overrides saved. Regenerate to see them applied.')), 'info');
		}).catch(function() {
			ui.addNotification(null, E('p', _('Save failed.')), 'error');
		});
	},

	_handleClearExtra: function() {
		if (!confirm(_('Clear /etc/prism/extra.json?'))) return;
		return callSetExtraConfig('').then(function() {
			var el = document.getElementById('prism-extra-text');
			if (el) el.value = '';
			ui.addNotification(null, E('p', _('Overrides cleared.')), 'info');
		}).catch(function() {
			ui.addNotification(null, E('p', _('Clear failed.')), 'error');
		});
	},

	handleSave:      null,
	handleSaveApply: null,
	handleReset:     null
});

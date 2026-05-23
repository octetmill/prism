// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

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

return baseclass.extend({
	load: function() {
		// A failed status RPC must not blank the tab — degrade to empty
		// data (Stopped / Unknown) so the controls stay usable.
		return callGetStatus().catch(function() { return {}; });
	},

	render: function(status) {
		var self = this;

		var node = E('div', { 'class': 'cbi-map' }, [
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
			])
		]);

		this._scheduleRefresh();

		return node;
	},

	_renderBadge: function(running) {
		return running
			? E('span', { 'class': 'label-success' }, [ _('Running') ])
			: E('span', { 'class': 'label-warning' }, [ _('Stopped') ]);
	},

	handleStart: function() {
		var self = this;
		return callStart().then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p', _('Start failed — check the Diagnostics log.')), 'error');
			} else {
				ui.addNotification(null, E('p', _('Service started.')), 'info');
			}
			return self._refreshNow();
		});
	},

	handleStop: function() {
		var self = this;
		return callStop().then(function() {
			ui.addNotification(null, E('p', _('Service stopped.')), 'info');
			return self._refreshNow();
		});
	},

	handleRestart: function() {
		var self = this;
		return callRestart().then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p', _('Restart failed — check the Diagnostics log.')), 'error');
			} else {
				ui.addNotification(null, E('p', _('Service restarted.')), 'info');
			}
			return self._refreshNow();
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
		this._scheduleRefresh();
	},

	_refreshNow: function() {
		return callGetStatus().then(L.bind(this.updateStatus, this));
	},

	_scheduleRefresh: function() {
		// Bail if the panel's DOM is gone (tab switched away) so a failed
		// in-flight poll cannot resurrect the timer after _teardown.
		if (!document.getElementById('prism-status-badge'))
			return;
		if (this._refreshTimer)
			clearTimeout(this._refreshTimer);
		this._refreshTimer = setTimeout(L.bind(function() {
			callGetStatus().then(L.bind(this.updateStatus, this)).catch(L.bind(function() {
				// reschedule even on RPC failure so the loop survives transient errors
				this._scheduleRefresh();
			}, this));
		}, this), 5000);
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

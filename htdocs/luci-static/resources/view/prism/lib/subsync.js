// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Per-row subscription Sync button handler shared by the Nodes and Basic
// panels — both render the same Sync column over the same UCI sections,
// and the two hand-rolled copies had already drifted (one restored the
// button's spinner class in `finally`, the other did not).

'use strict';
'require baseclass';
'require rpc';
'require ui';
'require uci';

var callSyncSubscription = rpc.declare({
	object: 'luci.prism',
	method: 'sync_subscription',
	params: ['id'],
	expect: { '': {} }
});

var callReloadIfChanged = rpc.declare({
	object: 'luci.prism',
	method: 'reload_if_changed',
	expect: { '': {} }
});

return baseclass.extend({
	// Spin the button in place (fixed width/height so the row doesn't
	// jump), sync the subscription, reload sing-box only if the active
	// outbound set changed, then remount the panel from re-read UCI.
	// `panel` is the calling panel instance (its _prismHost is set by
	// main.js when the panel mounts).
	handleSync: function(panel, ev, section_id) {
		var btn = ev.currentTarget, label = btn.textContent;
		var w = btn.offsetWidth, h = btn.offsetHeight;
		btn.classList.add('spinning');
		btn.style.width  = w + 'px';
		btn.style.height = h + 'px';
		btn.textContent  = '';
		return callSyncSubscription(section_id).then(function(res) {
			var ok = res && res.status === 'ok';
			ui.addNotification(null, E('p',
				ok ? _('Synced: %d nodes.').format(res.node_count || 0)
				   : _('Sync failed.')),
				ok ? 'info' : 'warning');
			if (!ok)
				return;
			return callReloadIfChanged().then(function(r) {
				if (r && r.reloaded)
					ui.addNotification(null,
						E('p', _('Active node changed — sing-box reloaded.')), 'info');
				// Close the edit modal first if the sync was triggered
				// from inside it — remountActive() would orphan it.
				ui.hideModal();
				// The RPC committed node_count / status / last_sync to UCI
				// on disk; reload from disk so the grid reflects them
				// without staging phantom changes the way uci.set would.
				uci.unload('prism');
				return uci.load('prism').then(function() {
					return panel._prismHost.remountActive();
				});
			});
		}).catch(function() {
			ui.addNotification(null, E('p', _('Sync failed.')), 'error');
		}).finally(function() {
			btn.classList.remove('spinning');
			btn.style.width  = '';
			btn.style.height = '';
			btn.textContent  = label;
		});
	}
});

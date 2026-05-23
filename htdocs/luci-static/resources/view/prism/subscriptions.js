// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require form';
'require ui';
'require uci';
'require rpc';
'require view.prism.lib.ordersave as ordersave';
'require view.prism.lib.formpanel as formpanel';

var callSyncSubscription = rpc.declare({
	object: 'luci.prism',
	method: 'sync_subscription',
	params: ['id'],
	expect: { '': {} }
});

var callSyncAll = rpc.declare({
	object: 'luci.prism',
	method: 'sync_all_subscriptions',
	expect: { '': {} }
});

var callReloadIfChanged = rpc.declare({
	object: 'luci.prism',
	method: 'reload_if_changed',
	expect: { '': {} }
});

var callListSubscriptionNodes = rpc.declare({
	object: 'luci.prism',
	method: 'list_subscription_nodes',
	params: ['id'],
	expect: { '': {} }
});

return baseclass.extend({
	load: function() {
		return uci.load('prism');
	},

	render: function() {
		var self = this;
		var m = new form.Map('prism');

		var s = m.section(form.GridSection, 'subscription', _('Subscriptions'),
			_('Proxy subscriptions. Changes are staged until Save; Save & Apply also reloads the service.'));
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add subscription');
		s.modaltitle = function() { return _('Subscription'); };

		var oEnabled = s.option(form.Flag, 'enabled', _('Enabled'));
		oEnabled['default'] = '1';
		oEnabled.rmempty = false;
		oEnabled.editable = true;

		var oName = s.option(form.Value, 'name', _('Name'));
		oName.rmempty = false;
		oName.placeholder = _('My Subscription');

		s.option(form.DummyValue, 'node_count', _('Nodes'));

		var oView = s.option(form.Button, '_view', _('View'));
		oView.modalonly = false;
		oView.editable = true;
		oView.inputtitle = _('View');
		oView.inputstyle = 'neutral';
		oView.onclick = function(ev, section_id) {
			return self._showNodes(section_id);
		};

		s.option(form.DummyValue, 'last_sync',  _('Last sync'));
		s.option(form.DummyValue, 'status',     _('Status'));

		var oUrl = s.option(form.Value, 'url', _('URL'));
		oUrl.modalonly = true;
		oUrl.rmempty = false;
		oUrl.placeholder = 'https://example.com/sub';

		var oAuto = s.option(form.Value, 'auto_update', _('Auto-update (hours)'),
			_('0 disables periodic refresh.'));
		oAuto.modalonly = true;
		oAuto.datatype = 'uinteger';
		oAuto['default'] = '0';

		var oUA = s.option(form.Value, 'user_agent', _('User-Agent'));
		oUA.modalonly = true;
		oUA.placeholder = _('Leave blank for default');

		var oSync = s.option(form.Button, '_sync', _('Sync'));
		oSync.modalonly = false;
		oSync.editable = true;
		oSync.inputtitle = _('Sync');
		oSync.inputstyle = 'apply';
		oSync.onclick = function(ev, section_id) {
			var btn = ev.currentTarget, label = btn.textContent;
			btn.classList.remove('spinning');
			var w = btn.offsetWidth, h = btn.offsetHeight;
			btn.classList.add('spinning');
			btn.style.width  = w + 'px';
			btn.style.height = h + 'px';
			btn.textContent = '';
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
							E('p', _('Active outbound changed — sing-box reloaded.')), 'info');
					// Close the edit modal first if the sync was triggered
					// from inside it — remountActive() would orphan it.
					ui.hideModal();
					// The RPC committed node_count / status / last_sync to UCI
					// on disk; reload from disk so the grid reflects them
					// without staging phantom changes the way uci.set would.
					uci.unload('prism');
					return uci.load('prism').then(function() {
						return self._prismHost.remountActive();
					});
				});
			}).catch(function() {
				ui.addNotification(null, E('p', _('Sync failed.')), 'error');
			}).finally(function() {
				btn.style.width  = '';
				btn.style.height = '';
				btn.textContent = label;
			});
		};

		this.map = m;
		ordersave.install(m, 'subscription');
		return m.render().then(function(node) {
			var create = node.querySelector('.cbi-section-create');
			if (create)
				create.appendChild(E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'style': 'margin-left:0.4em',
					'click': ui.createHandlerFn(self, '_syncAll')
				}, [ _('Sync all now') ]));
			return node;
		});
	},

	_showNodes: function(section_id) {
		var name = uci.get('prism', section_id, 'name') || section_id;
		ui.showModal(_('Nodes — %s').format(name), [
			E('p', { 'class': 'spinning' }, [ _('Loading…') ]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ _('Close') ])
			])
		]);
		return callListSubscriptionNodes(section_id).then(function(res) {
			var nodes = (res && res.nodes) || [];
			var content;
			if (nodes.length === 0) {
				content = E('p', {}, [
					_('No nodes. Sync this subscription to populate the list.')
				]);
			} else {
				var rows = [
					E('tr', { 'class': 'tr cbi-section-table-titles' }, [
						E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Name') ]),
						E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Type') ]),
						E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Server') ])
					])
				];
				for (var i = 0; i < nodes.length; i++) {
					var n = nodes[i];
					var srv = n.server || '';
					if (srv !== '' && n.server_port)
						srv += ':' + n.server_port;
					rows.push(E('tr', { 'class': 'tr cbi-section-table-row' }, [
						E('td', { 'class': 'td' }, [ n.tag || '' ]),
						E('td', { 'class': 'td' }, [ n.type || '' ]),
						E('td', { 'class': 'td' }, [ srv ])
					]));
				}
				content = E('div', { 'style': 'max-height:60vh; overflow:auto' }, [
					E('table', { 'class': 'table cbi-section-table' }, rows)
				]);
			}
			ui.showModal(_('Nodes — %s (%d)').format(name, nodes.length), [
				content,
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': ui.hideModal
					}, [ _('Close') ])
				])
			]);
		}).catch(function() {
			ui.showModal(_('Nodes — %s').format(name), [
				E('p', {}, [ _('Failed to load nodes.') ]),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': ui.hideModal
					}, [ _('Close') ])
				])
			]);
		});
	},

	_syncAll: function() {
		var self = this;
		ui.showModal(_('Sync all subscriptions'), [
			E('p', {}, [
				_('This downloads every subscription and then reloads this tab ' +
				  'from the saved configuration. Unsaved changes on this tab ' +
				  'will be discarded.')
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, '_doSyncAll')
				}, [ _('Sync all') ])
			])
		]);
	},

	_doSyncAll: function() {
		var self = this;
		ui.hideModal();
		return callSyncAll().then(function(res) {
			ui.addNotification(null, E('p',
				_('Sync all complete: %d synced, %d errors.')
					.format(res.synced || 0, res.errors || 0)),
				(res.errors || 0) > 0 ? 'warning' : 'info');
			if (res && res.reloaded)
				ui.addNotification(null,
					E('p', _('Active outbound changed — sing-box reloaded.')), 'info');
			uci.unload('prism');
			return uci.load('prism').then(function() {
				return self._prismHost.remountActive();
			});
		}).catch(function() {
			ui.addNotification(null, E('p', _('Sync all failed.')), 'error');
		});
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.resetGrid(this); }
});

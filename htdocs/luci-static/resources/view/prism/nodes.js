// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Nodes tab: subscriptions on top, manually-configured nodes below.
// "Node" is the user-facing noun for what sing-box calls an outbound — it
// covers both individual servers and group outbounds (urltest/selector). The
// UCI section names (`node`, `subscription`) and the RPC method names
// (list_outbounds) keep the historic spelling.
// Both sections share one form.Map('prism') so a single Save & Apply commits
// edits to both — they already share the same UCI config and the same global
// revert (formpanel.resetGrid calls ui.changes.revert), so a unified footer is
// the natural UX.

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

var callListOutbounds = rpc.declare({
	object: 'luci.prism',
	method: 'list_outbounds',
	expect: { '': {} }
});

// Types with a server endpoint. `direct` is excluded — a direct outbound has
// no server field (build-config drops it); it is just an optional override.
var SERVER_TYPES    = ['vless','vmess','trojan','shadowsocks','hysteria2','tuic','anytls','wireguard','socks'];
var TRANSPORT_TYPES = ['vless','vmess','trojan','anytls'];

// Add one depends() clause per accepted value (LuCI ORs separate calls).
// `extra` keys are ANDed into every clause.
function depAny(o, field, values, extra) {
	values.forEach(function(v) {
		var d = {};
		d[field] = v;
		if (extra)
			for (var k in extra) d[k] = extra[k];
		o.depends(d);
	});
}

return baseclass.extend({
	load: function() {
		// A failed list_outbounds must not kill the tab — degrade to an
		// empty outbound list instead.
		return Promise.all([
			uci.load('prism'),
			callListOutbounds().catch(function() { return {}; })
		]);
	},

	render: function(data) {
		var self = this;
		var m = new form.Map('prism');

		this._renderSubscriptions(m);
		this._renderNodes(m, data);

		this.map = m;
		ordersave.install(m, 'subscription');
		ordersave.install(m, 'node');

		return m.render().then(function(node) {
			// "Sync all now" sits next to the Add button of the
			// subscriptions section — the first .cbi-section-create in
			// document order, since subscriptions render before nodes.
			var create = node.querySelector('.cbi-section-create');
			if (create)
				create.appendChild(E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'style': 'margin-left:0.4em',
					'click': ui.createHandlerFn(self, '_syncAll')
				}, [ _('Sync all now') ]));
			// Breathing room between the two GridSections — matches the
			// gap between sibling sections on the stock DHCP page.
			var nodeSection = node.querySelector('#cbi-prism-node');
			if (nodeSection)
				nodeSection.style.marginTop = '2em';
			return node;
		});
	},

	_renderSubscriptions: function(m) {
		var self = this;

		var s = m.section(form.GridSection, 'subscription', _('Subscriptions'),
			_('Node subscriptions.'));
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add');
		s.modaltitle = function() { return _('Subscription'); };

		var oEnabled = s.option(form.Flag, 'enabled', _('Enabled'));
		oEnabled['default'] = '1';
		oEnabled.rmempty = false;
		oEnabled.editable = true;

		var oName = s.option(form.Value, 'name', _('Name'));
		oName.rmempty = false;
		oName.placeholder = _('My Subscription');

		// RPC-populated read-only fields shown in the grid row only —
		// modalonly=false excludes them from the per-row edit modal.
		var oCount = s.option(form.DummyValue, 'node_count', _('Nodes'));
		oCount.modalonly = false;

		var oView = s.option(form.Button, '_view', _('View'));
		oView.modalonly = false;
		oView.editable = true;
		oView.inputtitle = _('View');
		oView.inputstyle = 'neutral';
		oView.onclick = function(ev, section_id) {
			return self._showNodes(section_id);
		};

		var oLast = s.option(form.DummyValue, 'last_sync',  _('Last sync'));
		oLast.modalonly = false;
		var oStatus = s.option(form.DummyValue, 'status',  _('Status'));
		oStatus.modalonly = false;

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
							E('p', _('Active node changed — sing-box reloaded.')), 'info');
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
	},

	_renderNodes: function(m, data) {
		var outbounds = (data && data[1] && Array.isArray(data[1].outbounds))
			? data[1].outbounds : [];

		// Map sub_id → human-readable name and display order. Two subscriptions
		// can carry nodes with identical tags; the label shown in the dropdown
		// must make clear which subscription a tag comes from. Manual nodes
		// (no subscription) and orphan tags (saved member whose source is
		// gone) get their own ordering buckets.
		var subName = {}, subOrder = {};
		uci.sections('prism', 'subscription').forEach(function(sub, idx) {
			subName[sub['.name']]  = sub.name || sub['.name'];
			subOrder[sub['.name']] = idx;
		});
		function labelFor(tag, sub_id) {
			if (sub_id && subName[sub_id])
				return subName[sub_id] + '/' + tag;
			return tag;
		}
		// Sort group: 0 = manual, 1+ = subscriptions in Subscriptions-section
		// order, Infinity = orphan (saved tag, source gone). Within a group,
		// the caller's original index preserves sync order for sub nodes and
		// Node-section order for manual nodes.
		function groupKey(sub_id) {
			if (!sub_id) return 0;
			if (sub_id in subOrder) return 1 + subOrder[sub_id];
			return Infinity;
		}

		// URLTest member candidates: live outbounds plus any tag already
		// stored on an existing urltest node, so a saved member whose node
		// was removed still shows rather than being silently dropped.
		var memberByTag = {};
		outbounds.forEach(function(ob, i) {
			if (ob && ob.tag && !(ob.tag in memberByTag)) {
				memberByTag[ob.tag] = {
					tag:   ob.tag,
					label: labelFor(ob.tag, ob.subscription),
					group: groupKey(ob.subscription),
					idx:   i
				};
			}
		});
		uci.sections('prism', 'node').forEach(function(n) {
			var obs = n.urltest_outbounds;
			if (!Array.isArray(obs))
				obs = obs ? String(obs).split(/[,\s]+/) : [];
			obs.forEach(function(t) {
				if (t && !(t in memberByTag)) {
					memberByTag[t] = { tag: t, label: t, group: Infinity, idx: 0 };
				}
			});
		});
		var memberList = [];
		for (var k in memberByTag) memberList.push(memberByTag[k]);
		memberList.sort(function(a, b) {
			if (a.group !== b.group) return a.group - b.group;
			if (a.idx   !== b.idx)   return a.idx   - b.idx;
			return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
		});

		var s = m.section(form.GridSection, 'node', _('Nodes'),
			_('Manually configured proxy nodes.'));
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add');
		s.modaltitle = function() { return _('Node'); };

		s.tab('general',   _('General'));
		s.tab('transport', _('Transport'));
		s.tab('tls',       _('TLS'));
		s.tab('group',     _('Group'));

		var o;

		// ── General: identity + protocol credentials ────────────────────
		// ListValue options below intentionally carry no `default`: the
		// first value() entry is the implicit default, so the field is
		// written once on create but not re-written on an unchanged save
		// (which would register a phantom UCI change).
		var oTag = s.taboption('general', form.Value, 'tag', _('Name'));
		oTag.rmempty = false;
		oTag.placeholder = _('e.g. MY-VPS-HK');

		var oType = s.taboption('general', form.ListValue, 'type', _('Type'));
		[['urltest','URLTest'],['selector','Selector'],
		 ['vless','VLESS'],['vmess','VMess'],['trojan','Trojan'],
		 ['shadowsocks','Shadowsocks'],['hysteria2','Hysteria2'],['tuic','TUIC'],
		 ['anytls','AnyTLS'],['wireguard','WireGuard'],['socks','SOCKS5'],
		 ['direct','Direct']].forEach(function(t) {
			oType.value(t[0], t[1]);
		});

		o = s.taboption('general', form.Value, 'server', _('Server'));
		o.modalonly = true;
		o.placeholder = _('hostname or IP');
		depAny(o, 'type', SERVER_TYPES);

		o = s.taboption('general', form.Value, 'server_port', _('Port'));
		o.modalonly = true;
		o.datatype = 'port';
		o.placeholder = '443';
		depAny(o, 'type', SERVER_TYPES);

		o = s.taboption('general', form.Value, 'uuid', _('UUID'));
		o.modalonly = true;
		depAny(o, 'type', ['vless','vmess','tuic']);

		o = s.taboption('general', form.Value, 'password', _('Password'));
		o.modalonly = true;
		o.password = true;
		depAny(o, 'type', ['trojan','shadowsocks','hysteria2','tuic','anytls','socks']);

		o = s.taboption('general', form.ListValue, 'security', _('Security'));
		['auto','aes-128-gcm','chacha20-poly1305','none','zero'].forEach(function(v) {
			o.value(v, v);
		});
		o.modalonly = true;
		o.depends('type', 'vmess');

		o = s.taboption('general', form.Value, 'alter_id', _('Alter ID'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '0';
		o.depends('type', 'vmess');

		o = s.taboption('general', form.ListValue, 'flow', _('Flow'));
		o.value('', _('None'));
		o.value('xtls-rprx-vision', 'xtls-rprx-vision');
		o.modalonly = true;
		o.optional = true;
		o.depends('type', 'vless');

		o = s.taboption('general', form.ListValue, 'method', _('Method'));
		['aes-256-gcm','aes-128-gcm','chacha20-ietf-poly1305','2022-blake3-aes-128-gcm',
		 '2022-blake3-aes-256-gcm','2022-blake3-chacha20-poly1305'].forEach(function(v) {
			o.value(v, v);
		});
		o.modalonly = true;
		o.depends('type', 'shadowsocks');

		o = s.taboption('general', form.Value, 'username', _('Username'));
		o.modalonly = true;
		o.depends('type', 'socks');

		o = s.taboption('general', form.ListValue, 'obfs_type', _('Obfuscation'));
		o.value('', _('None'));
		o.value('salamander', 'salamander');
		o.modalonly = true;
		o.optional = true;
		o.depends('type', 'hysteria2');

		o = s.taboption('general', form.Value, 'obfs_password', _('Obfs password'));
		o.modalonly = true;
		o.password = true;
		o.depends({ type: 'hysteria2', obfs_type: 'salamander' });

		o = s.taboption('general', form.ListValue, 'congestion_control', _('Congestion'));
		['cubic','new_reno','bbr'].forEach(function(v) { o.value(v, v); });
		o.modalonly = true;
		o.depends('type', 'tuic');

		o = s.taboption('general', form.ListValue, 'udp_relay_mode', _('UDP relay'));
		o.value('', _('Default'));
		o.value('native', 'native');
		o.value('quic', 'quic');
		o.modalonly = true;
		o.optional = true;
		o.depends('type', 'tuic');

		o = s.taboption('general', form.Value, 'override_address', _('Override address'));
		o.modalonly = true;
		o.depends('type', 'direct');

		o = s.taboption('general', form.Value, 'override_port', _('Override port'));
		o.modalonly = true;
		o.datatype = 'port';
		o.depends('type', 'direct');

		// ── WireGuard ───────────────────────────────────────────────────
		o = s.taboption('general', form.Value, 'wg_local_address', _('Local address'));
		o.modalonly = true;
		o.placeholder = '10.0.0.2/32';
		o.depends('type', 'wireguard');

		o = s.taboption('general', form.Value, 'wg_private_key', _('Private key'));
		o.modalonly = true;
		o.password = true;
		o.depends('type', 'wireguard');

		o = s.taboption('general', form.Value, 'wg_peer_public_key', _('Peer public key'));
		o.modalonly = true;
		o.depends('type', 'wireguard');

		o = s.taboption('general', form.Value, 'wg_preshared_key', _('Pre-shared key'));
		o.modalonly = true;
		o.password = true;
		o.depends('type', 'wireguard');

		o = s.taboption('general', form.Value, 'wg_mtu', _('MTU'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '1408';
		o.depends('type', 'wireguard');

		// ── Transport ───────────────────────────────────────────────────
		o = s.taboption('transport', form.ListValue, 'transport_type', _('Transport'));
		o.value('', _('None'));
		o.value('ws',   'WebSocket');
		o.value('grpc', 'gRPC');
		o.value('http', 'HTTP/2');
		o.modalonly = true;
		o.optional = true;
		depAny(o, 'type', TRANSPORT_TYPES);

		o = s.taboption('transport', form.Value, 'transport_ws_path', _('WS path'));
		o.modalonly = true;
		o.placeholder = '/';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'ws' });

		o = s.taboption('transport', form.Value, 'transport_ws_host', _('WS host header'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'ws' });

		o = s.taboption('transport', form.Value, 'transport_grpc_service', _('gRPC service'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'grpc' });

		o = s.taboption('transport', form.Value, 'transport_http_path', _('HTTP path'));
		o.modalonly = true;
		o.placeholder = '/';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'http' });

		o = s.taboption('transport', form.Value, 'transport_http_host', _('HTTP host'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'http' });

		// ── TLS ─────────────────────────────────────────────────────────
		o = s.taboption('tls', form.Flag, 'tls_enabled', _('TLS'));
		o.modalonly = true;
		depAny(o, 'type', ['vless','vmess']);

		var oSni = s.taboption('tls', form.Value, 'tls_sni', _('SNI'));
		oSni.modalonly = true;
		oSni.placeholder = _('e.g. example.com');

		var oInsec = s.taboption('tls', form.Flag, 'tls_insecure', _('Allow insecure'));
		oInsec.modalonly = true;

		var oFp = s.taboption('tls', form.ListValue, 'tls_fingerprint', _('uTLS fingerprint'));
		oFp.value('', _('Default'));
		['chrome','firefox','safari','ios','edge','random'].forEach(function(v) {
			oFp.value(v, v);
		});
		oFp.modalonly = true;
		oFp.optional = true;

		// TLS detail fields: always shown for forced-TLS protocols, opt-in
		// (tls_enabled) for vless / vmess.
		[oSni, oInsec, oFp].forEach(function(opt) {
			depAny(opt, 'type', ['trojan','hysteria2','tuic','anytls']);
			opt.depends({ type: 'vless', tls_enabled: '1' });
			opt.depends({ type: 'vmess', tls_enabled: '1' });
		});

		// ── Group (urltest + selector) ──────────────────────────────────
		// Both group types share `urltest_outbounds` as the member list — the
		// UCI key keeps its historic name. Selector is manual-only (it needs an
		// explicit default), so the mode/regex/url/interval/tolerance knobs are
		// urltest-exclusive; `selector_default` is selector-exclusive.
		o = s.taboption('group', form.ListValue, 'urltest_mode', _('Selection mode'));
		o.value('manual', _('Manual (select nodes)'));
		o.value('regex',  _('Regex (match by tag)'));
		o.modalonly = true;
		o.depends('type', 'urltest');

		// Shared label lookup used by the dynamic selector_default dropdown
		// below (both at modal open and inside oMembers.onchange).
		var memberLabel = {};
		memberList.forEach(function(m) { memberLabel[m.tag] = m.label; });

		o = s.taboption('group', form.MultiValue, 'urltest_outbounds', _('Members'));
		// 'select' renders a ui.Dropdown multi-select: checkboxes plus a
		// built-in filter field inside the opened dropdown panel.
		o.widget = 'select';
		memberList.forEach(function(m) { o.value(m.tag, m.label); });
		o.modalonly = true;
		o.depends({ type: 'urltest', urltest_mode: 'manual' });
		o.depends('type', 'selector');
		// When the picked member list changes, repopulate the sibling
		// `selector_default` dropdown. Crucial: the GridSection edit modal
		// builds a separate CBIMap with *clones* of these options
		// (form.js renderMoreOptionsModal → cloneOptions), so a
		// closure-captured reference to the outer `oDefault` would resolve
		// to the wrong map. We look up the sibling option through `this.map`,
		// which inside the modal IS the modal's clone map.
		o.onchange = function(ev, section_id, value) {
			var opts = this.map.lookupOption('selector_default', section_id);
			var opt  = opts && opts[0];
			if (!opt) return;
			var widget = opt.getUIElement(section_id);
			if (!widget) return;
			var picked  = Array.isArray(value) ? value : (value ? [value] : []);
			var current = widget.getValue();
			var keys    = [''].concat(picked);
			var labels  = { '': _('— none —') };
			picked.forEach(function(t) { labels[t] = memberLabel[t] || t; });
			widget.clearChoices(true);
			widget.addChoices(keys, labels);
			widget.setValue(picked.indexOf(current) >= 0 ? current : '');
		};

		o = s.taboption('group', form.Value, 'urltest_regex', _('Tag pattern'));
		o.modalonly = true;
		o.placeholder = '.*HK.*|.*JP.*';
		o.depends({ type: 'urltest', urltest_mode: 'regex' });

		// Restrict regex matching to nodes from selected sources. Empty =
		// match across every source (the behaviour before this field existed).
		// Sentinel `_manual` covers UCI-defined manual nodes; remaining values
		// are subscription section names. Subscriptions are anonymous
		// (cfgXXXX), so `_manual` cannot collide with a real subscription id.
		o = s.taboption('group', form.MultiValue, 'urltest_regex_sources', _('Sources'),
			_('Subscriptions whose nodes are evaluated against the pattern. ' +
			  'Leave empty to match nodes from every source.'));
		o.widget = 'select';
		o.value('_manual', _('Manual nodes'));
		uci.sections('prism', 'subscription').forEach(function(sub) {
			o.value(sub['.name'], sub.name || sub['.name']);
		});
		o.modalonly = true;
		o.optional = true;
		o.depends({ type: 'urltest', urltest_mode: 'regex' });

		// Test URL: combobox (form.Value auto-promotes to ui.Combobox when
		// .value() entries are present) — preset picks for the two most
		// common /generate_204 endpoints, plus free-text entry for any
		// custom URL the user prefers to type.
		o = s.taboption('group', form.Value, 'urltest_url', _('Test URL'));
		o.modalonly = true;
		o.depends('type', 'urltest');
		o.default = 'https://www.gstatic.com/generate_204';
		// Required (default is set) — drops the "unspecified" empty entry
		// that form.Value would otherwise insert in the Combobox dropdown.
		o.rmempty = false;
		o.value('https://www.gstatic.com/generate_204',     'Google (HTTPS)');
		o.value('http://www.gstatic.com/generate_204',      'Google (HTTP)');
		o.value('https://cp.cloudflare.com/generate_204',   'Cloudflare (HTTPS)');
		o.value('http://cp.cloudflare.com/generate_204',    'Cloudflare (HTTP)');

		o = s.taboption('group', form.Value, 'urltest_interval', _('Interval'));
		o.modalonly = true;
		o.placeholder = '3m';
		o.depends('type', 'urltest');

		o = s.taboption('group', form.Value, 'urltest_tolerance', _('Tolerance (ms)'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.depends('type', 'urltest');

		// Selector default: optional. The choice list is filtered at modal
		// open to the section's currently-picked members and kept in sync
		// by oMembers.onchange above.
		var oDefault = s.taboption('group', form.ListValue, 'selector_default', _('Default member'));
		oDefault.modalonly = true;
		oDefault.optional = true;
		oDefault.depends('type', 'selector');

		// Read the picked members of the currently-edited section. Inside the
		// modal, `map` is the modal's clone CBIMap, so lookupOption resolves
		// to the cloned `urltest_outbounds` whose formvalue/cfgvalue both
		// reach the right widget/data.
		function pickedMembers(map, section_id) {
			var opts = map.lookupOption('urltest_outbounds', section_id);
			var opt  = opts && opts[0];
			if (!opt) return [];
			var v = opt.formvalue(section_id);
			if (v === null || v === undefined) v = opt.cfgvalue(section_id);
			if (Array.isArray(v)) return v;
			if (typeof v === 'string' && v !== '')
				return v.split(/[,\s]+/).filter(Boolean);
			return [];
		}

		// form.ListValue's default renderWidget builds a native <select> via
		// ui.Select, which has no addChoices/clearChoices methods — so the
		// oMembers.onchange handler couldn't update it. Render a single-
		// select ui.Dropdown directly so the live add/remove path works
		// (mirrors form.MultiValue's own widget pick).
		//
		// At the moment renderWidget runs during the modal-open render pass,
		// the cloned `urltest_outbounds` option's `.data[section_id]` has
		// not yet been populated by the modal map's section.load chain
		// (verified empirically — calling renderWidget *after* modal mount
		// produces the correct dropdown, but the initial call sees no
		// picked members). So we render an empty placeholder synchronously
		// to satisfy the render Promise, then in a `setTimeout(0)` — one
		// tick later, with the modal in the DOM and load complete — call
		// addChoices() to populate the real member list.
		oDefault.renderWidget = function(section_id, option_index, cfgvalue) {
			var initialValue = (cfgvalue != null) ? cfgvalue : '';
			var widget = new ui.Dropdown(initialValue, { '': _('— none —') }, {
				id:                 this.cbid(section_id),
				sort:               [''],
				optional:           true,
				select_placeholder: _('— none —'),
				validate:           this.getValidator(section_id),
				disabled:           this.map.readonly
			});
			var node = widget.render();
			var self = this;
			setTimeout(function() {
				var w = self.getUIElement(section_id);
				if (!w) return;
				var picked = pickedMembers(self.map, section_id);
				if (!picked.length) return;
				var labels = {};
				picked.forEach(function(t) { labels[t] = memberLabel[t] || t; });
				w.addChoices(picked, labels);
				if (initialValue && picked.indexOf(initialValue) >= 0)
					w.setValue(initialValue);
			}, 0);
			return node;
		};

		oDefault.validate = function(section_id, value) {
			if (!value) return true;
			var picked = pickedMembers(this.map, section_id);
			if (picked.indexOf(value) < 0)
				return _('Default must be one of the selected members.');
			return true;
		};
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
					E('p', _('Active node changed — sing-box reloaded.')), 'info');
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

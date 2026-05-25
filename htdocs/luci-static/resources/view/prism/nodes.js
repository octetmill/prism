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

var callTestNode = rpc.declare({
	object: 'luci.prism',
	method: 'test_node',
	params: ['tag', 'timeout_ms'],
	expect: { '': {} }
});

var callGetLastLatency = rpc.declare({
	object: 'luci.prism',
	method: 'get_last_latency',
	expect: { '': {} }
});

// Group-delay endpoint: probes every member of the hidden _prism_test_all
// selector group in one HTTP call. sing-box parallelises internally — much
// faster than JS issuing N separate test_node RPCs and far less memory
// pressure (one rpcd worker, not 8 concurrent ones).
var callTestGroupDelay = rpc.declare({
	object: 'luci.prism',
	method: 'test_group_delay',
	params: ['tag', 'url', 'timeout_ms'],
	expect: { '': {} }
});

// Per-row Test button: timeout passed to the clash API's delay endpoint.
// 3 s is a balance — a working proxy answers gstatic.com/generate_204 in
// well under a second, and a node that needs longer is unlikely to be a
// useful pick anyway. The bulk "Test all" path goes through the group
// endpoint and uses its own larger timeout (the budget is shared across
// all members, not per-probe).
var TEST_TIMEOUT_MS = 3000;

// Color-coded latency badge. Maps a probe result `{ delay_ms?, error? }` to a
// span styled with the same label-* classes the rest of Prism uses.
//  green   < 150 ms   (close / direct path)
//  yellow  < 500 ms   (workable but slow)
//  red     ≥ 500 ms   or any error
function formatLatency(result) {
	if (!result)
		return E('span', { 'style': 'opacity:0.45;' }, [ '—' ]);
	if (typeof result.delay_ms === 'number') {
		var ms = result.delay_ms;
		var cls = (ms < 150) ? 'label-success'
		        : (ms < 500) ? 'label-warning'
		        :              'label-danger';
		return E('span', {
			'class': cls,
			'style': 'padding:1px 6px; border-radius:3px;',
			'title': result.tested_at ? _('Tested %s').format(relTime(result.tested_at)) : ''
		}, [ ms + ' ms' ]);
	}
	// Probe failed: the cached `error` string is sing-box's own message
	// (mapped via probe_node), e.g. "unreachable", "proxy not in running
	// config". Show it on hover so the cell doesn't grow to the longest
	// error length.
	var msg = result.error || _('error');
	return E('span', {
		'class': 'label-danger',
		'style': 'padding:1px 6px; border-radius:3px; cursor:help;',
		'title': msg + (result.tested_at ? '\n' + _('Tested %s').format(relTime(result.tested_at)) : '')
	}, [ msg.length > 14 ? msg.substring(0, 13) + '…' : msg ]);
}

// "2m ago" / "1h ago" / "3d ago" style relative timestamp from a unix epoch.
function relTime(ts) {
	if (!ts) return '';
	var diff = Math.floor(Date.now() / 1000 - ts);
	if (diff < 5)       return _('just now');
	if (diff < 60)      return diff + _('s ago');
	if (diff < 3600)    return Math.floor(diff / 60)    + _('m ago');
	if (diff < 86400)   return Math.floor(diff / 3600)  + _('h ago');
	return Math.floor(diff / 86400) + _('d ago');
}


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
		// A failed list_outbounds or get_last_latency must not kill the tab
		// — degrade to an empty list / empty cache instead.
		return Promise.all([
			uci.load('prism'),
			callListOutbounds().catch(function() { return {}; }),
			callGetLastLatency().catch(function() { return { results: {} }; })
		]);
	},

	render: function(data) {
		var self = this;
		var m = new form.Map('prism');

		// Latency cache: { tag → { delay_ms?, error?, tested_at } }. The
		// formatLatency helper reads from here on every grid render and
		// _refreshLatencyCells writes into it after each probe. Stored on
		// `this` so the per-row Test handlers can mutate it.
		this._latency = ((data && data[2] && data[2].results) || {});

		// tag → [ live <span> elements that should reflect this tag's
		// latency ]. Built up as cells render, drained when stale (DOM
		// disconnected). Used instead of a querySelectorAll on a
		// data-attribute, because tag values include emoji (🇭🇰, 🇯🇵, …) and
		// CSS attribute selector escapes for surrogate-pair characters are
		// not portable across browsers — the old code threw a SyntaxError
		// on the first emoji tag and broke the whole batch promise.
		this._latencyCells = {};

		this._renderSubscriptions(m);
		this._renderNodes(m, data);

		this.map = m;
		ordersave.install(m, 'subscription');
		ordersave.install(m, 'node');

		return m.render().then(function(node) {
			// "Sync all now" sits next to the Add button of the
			// subscriptions section — the first .cbi-section-create in
			// document order, since subscriptions render before nodes.
			var subsCreate = node.querySelector('.cbi-section-create');
			if (subsCreate)
				subsCreate.appendChild(E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'style': 'margin-left:0.4em',
					'click': ui.createHandlerFn(self, '_syncAll')
				}, [ _('Sync all now') ]));
			// "Test all" sits next to the Add button of the manual-nodes
			// section. Only shown when clash_api is on; without it every
			// probe returns "clash API disabled" and the button would just
			// flood the user with error notifications.
			var clashOn = (uci.get('prism', 'global', 'clash_api_enabled') === '1');
			if (clashOn) {
				var nodeCreates = node.querySelectorAll('.cbi-section-create');
				var nodeCreate = nodeCreates[nodeCreates.length - 1];
				if (nodeCreate && nodeCreate !== subsCreate)
					nodeCreate.appendChild(E('button', {
						'class': 'btn cbi-button cbi-button-neutral',
						'style': 'margin-left:0.4em',
						'click': ui.createHandlerFn(self, '_testAll')
					}, [ _('Test all') ]));
			}
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
		var self = this;
		var outbounds = (data && data[1] && Array.isArray(data[1].outbounds))
			? data[1].outbounds : [];
		// Used by _collectAllTags to drive "Test all" — same data the row
		// renderer already consumes, just kept available across handlers.
		this._outbounds = outbounds;

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

		// ── Latency + Test (grid-only) ───────────────────────────────────
		// Both columns appear only when clash_api is enabled; otherwise the
		// Test button would just emit a "clash API disabled" notification on
		// every click. Reading the UCI flag from the loaded prism config
		// (load() already pulled it in) keeps this synchronous.
		var clashOn = (uci.get('prism', 'global', 'clash_api_enabled') === '1');
		if (clashOn) {
			var oLatency = s.taboption('general', form.DummyValue, '_latency',
				_('Latency'));
			oLatency.modalonly = false;
			oLatency.editable  = true;
			// cfgvalue gets the section_id of the row — look up its tag in
			// UCI, then the cached probe result for that tag. The cell is
			// registered with _registerLatencyCell so _refreshLatencyCell
			// can update it later without re-rendering the whole grid.
			oLatency.cfgvalue = function(section_id) {
				var tag = uci.get('prism', section_id, 'tag') || '';
				var span = E('span', { 'class': 'prism-latency-cell' },
					[ formatLatency(self._latency[tag]) ]);
				self._registerLatencyCell(tag, span);
				return span;
			};

			var oTest = s.taboption('general', form.Button, '_test',
				_('Test'));
			oTest.modalonly  = false;
			oTest.editable   = true;
			oTest.inputtitle = _('Test');
			oTest.inputstyle = 'neutral';
			oTest.onclick    = function(ev, section_id) {
				var tag = uci.get('prism', section_id, 'tag') || '';
				if (!tag) return;
				return self._testOne(ev.currentTarget, tag);
			};
		}

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
		var self = this;
		var name = uci.get('prism', section_id, 'name') || section_id;
		var clashOn = (uci.get('prism', 'global', 'clash_api_enabled') === '1');
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
				var headerCells = [
					E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Name') ]),
					E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Type') ]),
					E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Server') ])
				];
				if (clashOn) {
					headerCells.push(E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Latency') ]));
					headerCells.push(E('th', { 'class': 'th cbi-section-table-cell cbi-section-actions' }, []));
				}
				var rows = [ E('tr', { 'class': 'tr cbi-section-table-titles' }, headerCells) ];
				for (var i = 0; i < nodes.length; i++) {
					var n = nodes[i];
					var srv = n.server || '';
					if (srv !== '' && n.server_port)
						srv += ':' + n.server_port;
					var cells = [
						E('td', { 'class': 'td' }, [ n.tag || '' ]),
						E('td', { 'class': 'td' }, [ n.type || '' ]),
						E('td', { 'class': 'td' }, [ srv ])
					];
					if (clashOn) {
						var tag = n.tag || '';
						var span = E('span', { 'class': 'prism-latency-cell' },
							[ formatLatency(self._latency[tag]) ]);
						self._registerLatencyCell(tag, span);
						cells.push(E('td', { 'class': 'td' }, [ span ]));
						cells.push(E('td', { 'class': 'td cbi-section-actions' }, [
							E('button', {
								'class': 'btn cbi-button cbi-button-neutral',
								'click': (function(t) {
									return function(ev) { self._testOne(ev.currentTarget, t); };
								})(tag)
							}, [ _('Test') ])
						]));
					}
					rows.push(E('tr', { 'class': 'tr cbi-section-table-row' }, cells));
				}
				content = E('div', { 'style': 'max-height:60vh; overflow:auto' }, [
					E('table', { 'class': 'table cbi-section-table' }, rows)
				]);
			}
			var footer = [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ _('Close') ])
			];
			if (clashOn && nodes.length > 0) {
				footer.unshift(' ');
				footer.unshift(E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': function() {
						var tags = [];
						nodes.forEach(function(n) {
							if (n.tag && n.type !== 'urltest' && n.type !== 'selector')
								tags.push(n.tag);
						});
						self._doTestAll(tags);
					}
				}, [ _('Test all in this subscription') ]));
			}
			ui.showModal(_('Nodes — %s (%d)').format(name, nodes.length), [
				content,
				E('div', { 'class': 'right' }, footer)
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

	// Register a freshly-rendered latency cell so _refreshLatencyCell can
	// find it later by tag. We use a plain object map instead of a CSS
	// attribute selector because tags include emoji (🇭🇰, 🇯🇵, …) whose
	// surrogate-pair escaping in CSS selectors isn't portable — browsers
	// vary in whether they accept '\d83c\dded' as a single character. A
	// JS string key sidesteps the issue entirely.
	_registerLatencyCell: function(tag, element) {
		if (!tag) return;
		var arr = this._latencyCells[tag];
		if (!arr) { arr = []; this._latencyCells[tag] = arr; }
		arr.push(element);
	},

	// Update every live cell registered for this tag. Drops references to
	// elements no longer in the DOM (e.g. closed subscription modals) so
	// the map can't grow unbounded across a long-running session.
	_refreshLatencyCell: function(tag) {
		var arr = this._latencyCells[tag];
		if (!arr || arr.length === 0) return;
		var result = this._latency[tag];
		var live = [];
		for (var i = 0; i < arr.length; i++) {
			var el = arr[i];
			if (!el || !el.isConnected) continue;
			while (el.firstChild) el.removeChild(el.firstChild);
			el.appendChild(formatLatency(result));
			live.push(el);
		}
		this._latencyCells[tag] = live;
	},

	// Single-node probe. `btn` is the row's Test button; spin it in place
	// (preserves width/height so the row doesn't jump) until the RPC settles.
	_testOne: function(btn, tag) {
		var self = this;
		var label = btn.textContent;
		var w = btn.offsetWidth, h = btn.offsetHeight;
		btn.classList.add('spinning');
		btn.style.width  = w + 'px';
		btn.style.height = h + 'px';
		btn.textContent  = '';
		return callTestNode(tag, TEST_TIMEOUT_MS).then(function(r) {
			self._latency[tag] = r || {};
			self._refreshLatencyCell(tag);
		}).catch(function() {
			ui.addNotification(null,
				E('p', _('Test failed — check the Prism log on the Status page.')),
				'error');
		}).finally(function() {
			btn.style.width  = '';
			btn.style.height = '';
			btn.classList.remove('spinning');
			btn.textContent  = label;
		});
	},

	// Gather every concrete-endpoint tag known to Prism: manual nodes from
	// UCI (skipping group types) plus subscription nodes from the cached
	// outbound list. Dedup by tag — first-seen wins, matching build-config's
	// manual-overrides-subscription policy.
	_collectAllTags: function() {
		var tags = [], seen = {};
		uci.sections('prism', 'node').forEach(function(n) {
			var t = n.tag, ty = n.type;
			if (t && ty !== 'urltest' && ty !== 'selector' && !seen[t]) {
				seen[t] = true;
				tags.push(t);
			}
		});
		(this._outbounds || []).forEach(function(ob) {
			if (ob.tag && ob.subscription
			    && ob.type !== 'urltest' && ob.type !== 'selector'
			    && !seen[ob.tag]) {
				seen[ob.tag] = true;
				tags.push(ob.tag);
			}
		});
		return tags;
	},

	// Section "Test all" handler — confirms then dispatches.
	_testAll: function() {
		var tags = this._collectAllTags();
		if (tags.length === 0) {
			ui.addNotification(null, E('p', _('No nodes to test.')), 'info');
			return;
		}
		var self = this;
		ui.showModal(_('Test all nodes'), [
			E('p', {}, [
				_('Probe latency for %d nodes? sing-box probes the members of ' +
				  'a hidden test group in parallel internally, so the whole ' +
				  'batch typically finishes in 10–30 seconds regardless of ' +
				  'the count. A node that isn\'t in the running config — ' +
				  'see Settings → Latency testing → "Include all nodes" — ' +
				  'won\'t be in the test group and won\'t get a reading.')
					.format(tags.length)
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': function() { self._doTestAll(tags); }
				}, [ _('Test all') ])
			])
		]);
	},

	// Probe every node in one shot via sing-box's clash group-delay endpoint.
	// build-config emits a hidden _prism_test_all selector group containing
	// every concrete-endpoint outbound; sing-box probes the members in
	// parallel goroutines internally and returns one JSON blob — far faster
	// than JS issuing N test_node RPCs (no fork-storm of uclient-fetch + Lua
	// processes, no per-probe rpcd round-trip overhead).
	//
	// For per-subscription "Test all in this subscription" we still want to
	// scope to that subscription's tags; the response from the group endpoint
	// covers every member of the hidden group, which is fine — we just only
	// refresh the cells the caller cared about and ignore the rest (the
	// cache file is updated with everything regardless, so other open views
	// pick up the values on their own).
	_doTestAll: function(tags) {
		if (this._testAllRunning) {
			ui.addNotification(null,
				E('p', _('A latency test run is already in progress.')),
				'warning');
			return Promise.resolve();
		}
		this._testAllRunning = true;

		var self = this;
		ui.hideModal();

		var banner = ui.addNotification(_('Latency tests running'), [
			E('p', {}, [ _('Probing %d nodes in parallel…').format(tags.length) ]),
			E('p', { 'style': 'opacity:0.7; font-size:0.9em; margin:0;' }, [
				_('Tests run inside sing-box — you can switch tabs.')
			])
		], 'info');

		// 60 s budget is comfortable for ~300 nodes; sing-box's internal
		// pool runs ~10 probes in parallel and an unreachable node takes
		// up to ~5 s before timing out. The RPC clamps to 5 min anyway.
		var GROUP_TIMEOUT_MS = 60000;

		// LuCI's XHR-side RPC timeout defaults to 20 s (L.env.rpctimeout),
		// which is well under our 60 s budget — without overriding, the
		// browser aborts the XHR before sing-box has finished and the .catch
		// below fires even though the server-side probe completed cleanly.
		// L.env.rpctimeout is read at the moment the request is dispatched
		// (rpc.js → handleCallReply → Request.post), so we set, call (the
		// XHR is now configured), and restore right after — no need for the
		// override to live past the synchronous dispatch.
		var origRpcTimeout = L.env.rpctimeout;
		L.env.rpctimeout = 120;
		var p = callTestGroupDelay('_prism_test_all', '', GROUP_TIMEOUT_MS);
		L.env.rpctimeout = origRpcTimeout;

		return p
			.then(function(res) {
				self._testAllRunning = false;
				if (banner && banner.parentNode)
					banner.parentNode.removeChild(banner);

				if (res && res.error) {
					ui.addNotification(null, E('p',
						_('Test all failed: %s.').format(res.error)),
						'error');
					return;
				}
				// Merge the group result into our local cache and refresh
				// every cell the caller asked about. Tags the response
				// didn't mention are kept as-is — sing-box returns one
				// entry per member of the hidden group, so any missing tag
				// is one we shouldn't have asked to test (e.g. caller
				// passed a stale list).
				var results = (res && res.results) || {};
				tags.forEach(function(tag) {
					if (results[tag])
						self._latency[tag] = results[tag];
					self._refreshLatencyCell(tag);
				});
				// Also reflect any cells that exist in the DOM but weren't
				// in the caller's tag list — keeps open subscription modals
				// in sync after a global Test all.
				for (var t in results) {
					if (tags.indexOf(t) < 0) {
						self._latency[t] = results[t];
						self._refreshLatencyCell(t);
					}
				}

				var tested = res.tested || 0;
				var errors = res.errors || 0;
				ui.addNotification(null, E('p',
					errors > 0
						? _('Tested %d nodes — %d unreachable.').format(tested + errors, errors)
						: _('Tested %d nodes.').format(tested)),
					'info');
			})
			.catch(function(err) {
				self._testAllRunning = false;
				if (banner && banner.parentNode)
					banner.parentNode.removeChild(banner);
				ui.addNotification(null, E('p',
					_('Test all failed — check the Prism log on the Status page.')),
					'error');
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

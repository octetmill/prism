// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require form';
'require uci';
'require rpc';
'require view.prism.lib.ordersave as ordersave';
'require view.prism.lib.formpanel as formpanel';

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
		// Sort group: 0 = manual, 1+ = subscriptions in Subscriptions-tab
		// order, Infinity = orphan (saved tag, source gone). Within a group,
		// the caller's original index preserves sync order for sub nodes and
		// Node-tab order for manual nodes.
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

		var m = new form.Map('prism');
		var s = m.section(form.GridSection, 'node', _('Nodes'),
			_('Manually configured proxy nodes. Changes are staged until Save; ' +
			  'Save & Apply also reloads the service.'));
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add node');
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

		o = s.taboption('group', form.MultiValue, 'urltest_outbounds', _('Outbounds'));
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

		o = s.taboption('group', form.Value, 'urltest_url', _('Test URL'));
		o.modalonly = true;
		o.placeholder = 'https://www.gstatic.com/generate_204';
		o.depends('type', 'urltest');

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
		// open to the section's currently-picked Outbounds and kept in sync
		// by oMembers.onchange above.
		var oDefault = s.taboption('group', form.ListValue, 'selector_default', _('Default outbound'));
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

		oDefault.renderWidget = function(section_id, option_index, cfgvalue) {
			var picked = pickedMembers(this.map, section_id);
			this.keylist = [''].concat(picked);
			this.vallist = [_('— none —')].concat(
				picked.map(function(t) { return memberLabel[t] || t; }));
			return form.ListValue.prototype.renderWidget.call(this, section_id, option_index, cfgvalue);
		};

		oDefault.validate = function(section_id, value) {
			if (!value) return true;
			var picked = pickedMembers(this.map, section_id);
			if (picked.indexOf(value) < 0)
				return _('Default must be one of the selected outbounds.');
			return true;
		};

		this.map = m;
		ordersave.install(m, 'node');
		return m.render();
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.resetGrid(this); }
});

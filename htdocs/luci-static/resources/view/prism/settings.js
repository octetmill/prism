// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Settings tab: every UCI-backed configuration option lives here, on one
// scroll page. The form is divided into Basic (always visible) and Advanced
// (collapsed by default behind a <details> toggle). One form.Map covers all
// three UCI sections (global, inbounds, dns) so a single Save & Apply commits
// everything together — the previous five sub-tabs each had their own footer,
// which is a hopping cost the new layout removes.
//
// "Enable Prism" is intentionally NOT in this form: the Status page owns
// runtime control via Start/Stop, so the master flag has one source of truth.
//
// Advanced overrides (/etc/prism/extra.json) live at the bottom inside the
// same Advanced expander — they are RPC-backed rather than UCI-backed, so
// they hang off a sibling panel after the form.

'use strict';
'require baseclass';
'require form';
'require rpc';
'require ui';
'require view.prism.lib.formpanel as formpanel';

var callGetWanDns = rpc.declare({
	object: 'luci.prism',
	method: 'get_wan_dns',
	expect: { '': {} }
});

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

// DNS address validator — mirrors build-config's parse_dns_url. An optional
// scheme, a host that is a valid IP or hostname, an optional port, and an
// optional /path for https/h3. Rejecting malformed input here stops a value
// like "tls://1" from reaching sing-box, which aborts on it at startup.
function isIPv4(s) {
	var m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m)
		return false;
	for (var i = 1; i <= 4; i++)
		if (+m[i] > 255)
			return false;
	return true;
}

function isIPv6(s) {
	return /^[0-9A-Fa-f:]+$/.test(s) && (s.match(/:/g) || []).length >= 2;
}

function isHostname(s) {
	return /[A-Za-z]/.test(s) &&
		/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(s);
}

function validateDnsAddress(value, allowWan) {
	var v = String(value == null ? '' : value).trim();
	if (v === '')
		return true;
	if (allowWan && v === 'wan')
		return true;

	var rest = v, scheme = null;
	var m = v.match(/^([a-z0-9]+):\/\/(.+)$/);
	if (m) {
		scheme = m[1];
		rest = m[2];
	}
	if (scheme !== null && !/^(udp|tcp|tls|https|quic|h3)$/.test(scheme))
		return _('Unsupported scheme "%s" (use udp, tcp, tls, https, quic or h3)').format(scheme);

	rest = rest.replace(/\/.*$/, '');
	if (rest === '')
		return _('Missing server address');

	var b = rest.match(/^\[([0-9A-Fa-f:]+)\](?::\d+)?$/);
	if (b)
		return isIPv6(b[1]) ? true : _('Invalid IPv6 address');

	var hp = rest.match(/^(.+):(\d+)$/);
	var host = hp ? hp[1] : rest;
	if (host === '')
		return _('Missing server address');
	if (isIPv4(host) || isIPv6(host) || isHostname(host))
		return true;
	return _('"%s" is not a valid IP address or hostname').format(host);
}

return baseclass.extend({
	load: function() {
		// A failed RPC must not blank the tab — degrade to empty data.
		return Promise.all([
			callGetWanDns().catch(function() { return {}; }),
			callGetExtraConfig().catch(function() { return {}; })
		]);
	},

	render: function(results) {
		var wanDnsInfo = (results && results[0]) || {};
		var extraData  = (results && results[1]) || {};
		var wanDns     = wanDnsInfo.wan_dns || null;
		var extraText  = extraData.json || '';

		var m = new form.Map('prism', '', _('sing-box settings'));

		// Collect option objects that should live behind the Advanced expander.
		// After m.render(), each option's input id is `cbid.prism.<section>.<name>`
		// and the wrapping .cbi-value row gets a class added so a CSS toggle on
		// the map root can show/hide them as a group.
		var advOpts = [];

		function advance(opt) {
			advOpts.push(opt);
			return opt;
		}

		// ── General ──────────────────────────────────────────────────────
		var sGen = m.section(form.NamedSection, 'global', 'prism', _('General'));
		sGen.addremove = false;

		var oLog = sGen.option(form.ListValue, 'log_level',
			_('Log level'),
			_('Verbosity of the sing-box service log. Info logs every connection; warning is recommended for normal use.'));
		oLog.value('error', _('Error'));
		oLog.value('warn',  _('Warning'));
		oLog.value('info',  _('Info'));
		oLog.value('debug', _('Debug'));
		oLog.default = 'warn';

		// ── Network ──────────────────────────────────────────────────────
		var sNet = m.section(form.NamedSection, 'inbounds', 'prism', _('Network'));
		sNet.addremove = false;

		var oMode = sNet.option(form.ListValue, 'mode', _('Mode'),
			_('How LAN traffic enters sing-box: transparently via TProxy ' +
			  '(recommended), via a TUN virtual interface, or both TProxy ' +
			  'plus an explicit HTTP/SOCKS5 listener for app clients.'));
		oMode.value('tproxy',       _('TProxy only — transparent TCP + UDP via nftables'));
		oMode.value('tun',          _('TUN only — virtual L3 interface, sing-box manages routing'));
		oMode.value('tproxy_mixed', _('TProxy + Mixed — transparent proxy and explicit HTTP/SOCKS5'));
		oMode['default'] = 'tproxy';

		var oInet6 = sNet.option(form.Flag, 'inet6',
			_('Enable IPv6'), _('Proxy IPv6 traffic'));
		oInet6.rmempty = false;

		var oTproxyPort = advance(sNet.option(form.Value, 'tproxy_port', _('TProxy port')));
		oTproxyPort.datatype = 'port';
		oTproxyPort.placeholder = '7895';
		oTproxyPort.depends('mode', 'tproxy');
		oTproxyPort.depends('mode', 'tproxy_mixed');

		var oTproxySelf = advance(sNet.option(form.Flag, 'tproxy_self',
			_('Proxy router traffic'),
			_('Also send traffic originated by the router itself through sing-box ' +
			  '(needed for subscription / rule-set downloads when the source is blocked). ' +
			  'Disable only to keep admin traffic (SSH out, opkg, ntp) untunneled for debugging.')));
		oTproxySelf['default'] = '1';
		oTproxySelf.rmempty = false;
		oTproxySelf.depends('mode', 'tproxy');
		oTproxySelf.depends('mode', 'tproxy_mixed');

		var oMixedListen = advance(sNet.option(form.Value, 'mixed_listen', _('Mixed listen address')));
		oMixedListen.placeholder = '127.0.0.1';
		oMixedListen.depends('mode', 'tproxy_mixed');

		var oMixedPort = advance(sNet.option(form.Value, 'mixed_port', _('Mixed port')));
		oMixedPort.datatype = 'port';
		oMixedPort.placeholder = '2080';
		oMixedPort.depends('mode', 'tproxy_mixed');

		var oTunAddr = advance(sNet.option(form.Value, 'tun_address', _('TUN IPv4 address')));
		oTunAddr.placeholder = '172.19.0.1/30';
		oTunAddr.depends('mode', 'tun');

		var oTunMtu = advance(sNet.option(form.Value, 'tun_mtu', _('TUN MTU')));
		oTunMtu.datatype = 'uinteger';
		oTunMtu.placeholder = '9000';
		oTunMtu.depends('mode', 'tun');

		var oTunStack = advance(sNet.option(form.ListValue, 'tun_stack', _('TUN stack')));
		oTunStack.value('system', 'system');
		oTunStack.value('gvisor', 'gvisor');
		oTunStack.value('mixed',  'mixed');
		oTunStack['default'] = 'system';
		oTunStack.depends('mode', 'tun');

		var oTunAutoRoute = advance(sNet.option(form.Flag, 'tun_auto_route',
			_('Auto-route'), _('Set system routes to capture all traffic')));
		oTunAutoRoute['default'] = '1';
		oTunAutoRoute.rmempty = false;
		oTunAutoRoute.depends('mode', 'tun');

		// ── DNS ──────────────────────────────────────────────────────────
		var sDns = m.section(form.NamedSection, 'dns', 'prism', _('DNS'),
			_('DNS server selection follows your routing rules: a domain routed ' +
			  'directly resolves via the Local DNS, a proxied domain via the ' +
			  'Remote DNS. Local and reserved domains always use the on-router resolver.'));
		sDns.addremove = false;

		var oManaged = sDns.option(form.Flag, 'managed_dns', _('Managed DNS'),
			_('Point dnsmasq at sing-box so all LAN clients are resolved ' +
			  'through it. When off, only clients with a hardcoded public ' +
			  'resolver are intercepted.'));
		oManaged.rmempty = false;
		oManaged.default = '1';

		var oLocal = sDns.option(form.Value, 'local_server', _('Local DNS'),
			wanDns
				? _('Resolver for directly-routed traffic and for proxy node hostnames. Pick "WAN DNS" to follow the WAN-assigned resolver (currently %s), or type an explicit address.').format(wanDns)
				: _('Resolver for directly-routed traffic and for proxy node hostnames. Pick "WAN DNS" to follow the WAN-assigned resolver, or type an explicit address.'));
		oLocal.value('wan', _('WAN DNS (auto-detected)'));
		oLocal.optional = true;
		oLocal.placeholder = 'wan';
		oLocal.validate = function(section_id, value) {
			return validateDnsAddress(value, true);
		};

		var oRemoteServer = sDns.option(form.Value, 'remote_server', _('Remote DNS'),
			_('Resolver for proxied traffic. Leave blank to use Cloudflare ' +
			  'DNS-over-TLS (tls://1.1.1.1).'));
		oRemoteServer.optional = true;
		oRemoteServer.placeholder = 'tls://1.1.1.1';
		oRemoteServer.validate = function(section_id, value) {
			return validateDnsAddress(value, false);
		};

		var oFakeipEnabled = sDns.option(form.Flag, 'fakeip_enabled',
			_('Fake-IP for proxied domains'),
			_('Resolve every proxied domain to a synthetic IP so routing happens ' +
			  'by domain without an upstream DNS round-trip. Directly-routed and ' +
			  'local domains always resolve normally.'));
		oFakeipEnabled.rmempty = false;

		var oStrategy = advance(sDns.option(form.ListValue, 'strategy', _('Strategy')));
		oStrategy.value('',           _('default'));
		oStrategy.value('prefer_ipv4', 'prefer_ipv4');
		oStrategy.value('prefer_ipv6', 'prefer_ipv6');
		oStrategy.value('ipv4_only',   'ipv4_only');
		oStrategy.value('ipv6_only',   'ipv6_only');
		oStrategy.optional = true;

		var oFakeipV4 = advance(sDns.option(form.Value, 'fakeip_range_v4', _('Fake-IP IPv4 range')));
		oFakeipV4.placeholder = '198.18.0.0/15';
		oFakeipV4.datatype = 'cidr4';
		oFakeipV4.depends('fakeip_enabled', '1');

		var oFakeipV6 = advance(sDns.option(form.Value, 'fakeip_range_v6', _('Fake-IP IPv6 range')));
		oFakeipV6.placeholder = 'fc00::/18';
		oFakeipV6.datatype = 'cidr6';
		oFakeipV6.depends('fakeip_enabled', '1');

		this.map = m;
		this._advOpts = advOpts;

		return m.render().then(L.bind(this._postRender, this, extraText));
	},

	// Tag every advanced option's row with the prism-advanced class, install a
	// <details>-driven CSS toggle on the map root, and append the extra.json
	// editor (also tagged advanced) below the form.
	_postRender: function(extraText, formNode) {
		var self = this;

		// Each NamedSection-bound option's input id is
		// `cbid.prism.<sectionname>.<optionname>`. Find it and walk up to the
		// wrapping `.cbi-value` row. Depends-hidden rows still have a DOM
		// node (just hidden) so the class lands; if a row is somehow absent
		// (e.g. option not rendered at all), the lookup quietly skips it.
		this._advOpts.forEach(function(opt) {
			var sel = '#' + opt.cbid(opt.section.section).replace(/\./g, '\\.');
			var input = formNode.querySelector(sel);
			if (!input) return;
			var row = input.closest('.cbi-value');
			if (row) row.classList.add('prism-advanced');
		});

		// Extra-overrides panel — same class so it hides with the rest.
		var extraSection = E('div', {
			'class': 'cbi-section prism-advanced',
			'id':    'prism-extra-section'
		}, [
			E('h3', {}, [ _('Raw sing-box overrides') ]),
			E('div', { 'class': 'cbi-section-descr' }, [
				_('Optional JSON object stored at /etc/prism/extra.json. Top-level keys here shallow-merge into the generated config (arrays are replaced wholesale). Use sparingly — most settings have a dedicated field above.')
			]),
			E('textarea', {
				'id': 'prism-extra-text',
				'class': 'cbi-input-textarea',
				'style': 'width:100%; min-height:240px; font-family:monospace; font-size:0.82em; line-height:1.4;',
				'spellcheck': 'false',
				'placeholder': '{\n  "experimental": {\n    "clash_api": { "external_controller": "127.0.0.1:9090" }\n  }\n}'
			}, [ extraText ]),
			E('div', { 'style': 'margin-top:0.5em;' }, [
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

		// One inline <style> block scoped by the prism-show-advanced class.
		// Two `display` rules cover both .cbi-value rows (flex by default)
		// and the .cbi-section overrides panel (block).
		var styleEl = E('style', {}, [
			'.cbi-map .prism-advanced{display:none}' +
			'.cbi-map.prism-show-advanced .cbi-value.prism-advanced{display:flex}' +
			'.cbi-map.prism-show-advanced .cbi-section.prism-advanced{display:block}' +
			'.prism-adv-toggle{margin:1em 0 0.5em 0;padding:0.4em 0.6em;border:1px solid rgba(128,128,128,0.3);border-radius:3px;cursor:pointer}' +
			'.prism-adv-toggle summary{font-weight:bold;outline:none}'
		]);

		// <details> is the disclosure trigger — its open state drives the
		// CSS class on the map root. No body inside the details: the advanced
		// rows live in their original sections (hidden by default), so the
		// expander only flips a class, it doesn't move DOM.
		var details = E('details', { 'class': 'prism-adv-toggle' }, [
			E('summary', {}, [ _('Show advanced settings') ])
		]);
		details.addEventListener('toggle', function() {
			formNode.classList.toggle('prism-show-advanced', details.open);
		});

		formNode.appendChild(styleEl);
		formNode.appendChild(details);
		formNode.appendChild(extraSection);

		return formNode;
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

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.reset(this); }
});

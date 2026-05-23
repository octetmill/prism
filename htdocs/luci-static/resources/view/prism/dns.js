// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require form';
'require rpc';
'require view.prism.lib.formpanel as formpanel';

var callGetWanDns = rpc.declare({
	object: 'luci.prism',
	method: 'get_wan_dns',
	expect: { '': {} }
});

// Validate a DNS server address the way build-config's parse_dns_url reads it:
// an optional scheme, a host that is a valid IP or hostname, an optional port,
// and an optional /path for https/h3. Rejecting malformed input here stops a
// value like "tls://1" from reaching sing-box, which aborts on it at startup.
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
		// A failed get_wan_dns must not blank the DNS tab — it only feeds a
		// label hint, so degrade to empty data and render the form anyway.
		return callGetWanDns().catch(function() { return {}; });
	},

	render: function(info) {
		var wanDns = (info && info.wan_dns) ? info.wan_dns : null;

		var m = new form.Map('prism', '', _('sing-box DNS resolution'));

		var s = m.section(form.NamedSection, 'dns', 'prism', _('DNS'),
			_('DNS server selection follows your routing rules: a domain routed ' +
			  'directly resolves via the Local DNS, a proxied domain via the ' +
			  'Remote DNS. Local and reserved domains always use the on-router resolver.'));
		s.addremove = false;

		var oManaged = s.option(form.Flag, 'managed_dns', _('Managed DNS'),
			_('Point dnsmasq at sing-box so all LAN clients are resolved ' +
			  'through it. When off, only clients with a hardcoded public ' +
			  'resolver are intercepted.'));
		oManaged.rmempty = false;
		oManaged.default = '1';

		var oStrategy = s.option(form.ListValue, 'strategy', _('Strategy'));
		oStrategy.value('',           _('default'));
		oStrategy.value('prefer_ipv4', 'prefer_ipv4');
		oStrategy.value('prefer_ipv6', 'prefer_ipv6');
		oStrategy.value('ipv4_only',   'ipv4_only');
		oStrategy.value('ipv6_only',   'ipv6_only');
		oStrategy.optional = true;

		// Combobox: pick the "wan" preset for auto-detect, or type a literal
		// address. Resolver for directly-routed traffic and node hostnames.
		var oLocal = s.option(form.Value, 'local_server', _('Local DNS'),
			wanDns
				? _('Resolver for directly-routed traffic and for proxy node hostnames. Pick "WAN DNS" to follow the WAN-assigned resolver (currently %s), or type an explicit address.').format(wanDns)
				: _('Resolver for directly-routed traffic and for proxy node hostnames. Pick "WAN DNS" to follow the WAN-assigned resolver, or type an explicit address.'));
		oLocal.value('wan', _('WAN DNS (auto-detected)'));
		oLocal.optional = true;
		oLocal.placeholder = 'wan';
		oLocal.validate = function(section_id, value) {
			return validateDnsAddress(value, true);
		};

		var oRemoteServer = s.option(form.Value, 'remote_server', _('Remote DNS'),
			_('Resolver for proxied traffic. Leave blank to use Cloudflare ' +
			  'DNS-over-TLS (tls://1.1.1.1).'));
		oRemoteServer.optional = true;
		oRemoteServer.placeholder = 'tls://1.1.1.1';
		oRemoteServer.validate = function(section_id, value) {
			return validateDnsAddress(value, false);
		};

		var oFakeipEnabled = s.option(form.Flag, 'fakeip_enabled',
			_('Fake-IP for proxied domains'),
			_('Resolve every proxied domain to a synthetic IP so routing happens ' +
			  'by domain without an upstream DNS round-trip. Directly-routed and ' +
			  'local domains always resolve normally.'));
		oFakeipEnabled.rmempty = false;

		var oFakeipV4 = s.option(form.Value, 'fakeip_range_v4', _('Fake-IP IPv4 range'));
		oFakeipV4.placeholder = '198.18.0.0/15';
		oFakeipV4.datatype = 'cidr4';
		oFakeipV4.depends('fakeip_enabled', '1');

		var oFakeipV6 = s.option(form.Value, 'fakeip_range_v6', _('Fake-IP IPv6 range'));
		oFakeipV6.placeholder = 'fc00::/18';
		oFakeipV6.datatype = 'cidr6';
		oFakeipV6.depends('fakeip_enabled', '1');

		this.map = m;
		return m.render();
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.reset(this); }
});

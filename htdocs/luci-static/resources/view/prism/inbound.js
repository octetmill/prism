// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require form';
'require view.prism.lib.formpanel as formpanel';

return baseclass.extend({
	render: function() {
		var m = new form.Map('prism', '', _('sing-box inbound interfaces'));

		var s = m.section(form.NamedSection, 'inbounds', 'prism', _('Inbound'));
		s.addremove = false;

		var oMode = s.option(form.ListValue, 'mode', _('Mode'));
		oMode.value('tproxy',       _('TProxy only — transparent TCP + UDP via nftables'));
		oMode.value('tun',          _('TUN only — virtual L3 interface, sing-box manages routing'));
		oMode.value('tproxy_mixed', _('TProxy + Mixed — transparent proxy and explicit HTTP/SOCKS5'));
		oMode['default'] = 'tproxy';

		var oInet6 = s.option(form.Flag, 'inet6',
			_('Enable IPv6'), _('Proxy IPv6 traffic'));
		oInet6.rmempty = false;

		var oTproxyPort = s.option(form.Value, 'tproxy_port', _('TProxy port'));
		oTproxyPort.datatype = 'port';
		oTproxyPort.placeholder = '7895';
		oTproxyPort.depends('mode', 'tproxy');
		oTproxyPort.depends('mode', 'tproxy_mixed');

		var oTproxySelf = s.option(form.Flag, 'tproxy_self',
			_('Proxy router traffic'),
			_('Also send traffic originated by the router itself through sing-box ' +
			  '(needed for subscription / rule-set downloads when the source is blocked). ' +
			  'Disable only to keep admin traffic (SSH out, opkg, ntp) untunneled for debugging.'));
		oTproxySelf['default'] = '1';
		oTproxySelf.rmempty = false;
		oTproxySelf.depends('mode', 'tproxy');
		oTproxySelf.depends('mode', 'tproxy_mixed');

		var oTunAddr = s.option(form.Value, 'tun_address', _('TUN IPv4 address'));
		oTunAddr.placeholder = '172.19.0.1/30';
		oTunAddr.depends('mode', 'tun');

		var oTunMtu = s.option(form.Value, 'tun_mtu', _('TUN MTU'));
		oTunMtu.datatype = 'uinteger';
		oTunMtu.placeholder = '9000';
		oTunMtu.depends('mode', 'tun');

		var oTunStack = s.option(form.ListValue, 'tun_stack', _('TUN stack'));
		oTunStack.value('system', 'system');
		oTunStack.value('gvisor', 'gvisor');
		oTunStack.value('mixed',  'mixed');
		oTunStack['default'] = 'system';
		oTunStack.depends('mode', 'tun');

		var oTunAutoRoute = s.option(form.Flag, 'tun_auto_route',
			_('Auto-route'), _('Set system routes to capture all traffic'));
		oTunAutoRoute['default'] = '1';
		oTunAutoRoute.rmempty = false;
		oTunAutoRoute.depends('mode', 'tun');

		var oMixedListen = s.option(form.Value, 'mixed_listen', _('Mixed listen address'));
		oMixedListen.placeholder = '127.0.0.1';
		oMixedListen.depends('mode', 'tproxy_mixed');

		var oMixedPort = s.option(form.Value, 'mixed_port', _('Mixed port'));
		oMixedPort.datatype = 'port';
		oMixedPort.placeholder = '2080';
		oMixedPort.depends('mode', 'tproxy_mixed');

		this.map = m;
		return m.render();
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.reset(this); }
});

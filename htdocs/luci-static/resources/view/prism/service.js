// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require form';
'require view.prism.lib.formpanel as formpanel';

return baseclass.extend({
	render: function() {
		var m = new form.Map('prism', '', _('sing-box service'));

		var s = m.section(form.NamedSection, 'global', 'prism', _('Service'));
		s.addremove = false;

		var oEnabled = s.option(form.Flag, 'enabled',
			_('Enable Prism'), _('Start sing-box at boot'));
		oEnabled.rmempty = false;

		var oLog = s.option(form.ListValue, 'log_level',
			_('Log level'),
			_('Verbosity of the sing-box service log. Info logs every connection; warning is recommended for normal use.'));
		oLog.value('error', _('Error'));
		oLog.value('warn',  _('Warning'));
		oLog.value('info',  _('Info'));
		oLog.value('debug', _('Debug'));
		oLog.default = 'warn';

		this.map = m;
		return m.render();
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.reset(this); }
});

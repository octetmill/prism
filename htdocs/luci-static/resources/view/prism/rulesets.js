// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require form';
'require view.prism.lib.formpanel as formpanel';

return baseclass.extend({
	render: function() {
		var m = new form.Map('prism', '',
			_('Where routing rules fetch their rule-sets. sing-box downloads ' +
			  'and refreshes each rule-set itself; routing rules reference ' +
			  'them by "provider/name" or by a custom label.'));

		var s = m.section(form.NamedSection, 'global', 'prism', _('Rule-sets'));
		s.addremove = false;

		var oDelivery = s.option(form.ListValue, 'ruleset_delivery', _('Delivery'),
			_('GitHub raw, or the jsDelivr CDN for GitHub-blocked regions.'));
		oDelivery.value('github',   _('GitHub (raw)'));
		oDelivery.value('jsdelivr', _('jsDelivr CDN'));
		oDelivery['default'] = 'github';

		var oDetour = s.option(form.ListValue, 'ruleset_download_detour', _('Download via'),
			_('How sing-box fetches rule-sets: straight out the WAN, or ' +
			  'through the default outbound (the proxy) when the WAN cannot ' +
			  'reach the rule-set host.'));
		oDetour.value('direct',  _('Direct (WAN)'));
		oDetour.value('default', _('Default outbound (proxy)'));
		oDetour['default'] = 'direct';

		var oCountry = s.option(form.ListValue, 'country_provider', _('Country provider'),
			_('Source for the geoip / geosite rule-sets that a routing rule\'s ' +
			  'Countries field expands to.'));
		oCountry.value('sagernet',  'SagerNet');
		oCountry.value('metacubex', 'MetaCubeX');
		oCountry['default'] = 'sagernet';

		var cs = m.section(form.GridSection, 'customrs', _('Custom rule-sets'),
			_('Rule-sets fetched from an explicit URL. Reference one in a ' +
			  'routing rule by its label.'));
		cs.addremove = true;
		cs.anonymous = true;
		cs.addbtntitle = _('Add custom rule-set');

		var oLabel = cs.option(form.Value, 'label', _('Label'));
		oLabel.rmempty = false;
		oLabel.validate = function(section_id, value) {
			if (!value)
				return _('A label is required.');
			if (value.indexOf('/') >= 0)
				return _('The label must not contain "/".');
			return true;
		};

		var oUrl = cs.option(form.Value, 'url', _('URL'));
		oUrl.rmempty = false;
		oUrl.placeholder = 'https://…/rules.srs';

		var oFmt = cs.option(form.ListValue, 'format', _('Format'));
		oFmt.value('binary', _('Binary (.srs)'));
		oFmt.value('source', _('Source (.json)'));
		oFmt['default'] = 'binary';

		this.map = m;
		return m.render();
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.reset(this); }
});

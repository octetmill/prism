// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Basic tab. Shown only when prism.global.mode = "basic"; the host view in
// main.js does the gating. The form binds to:
//
//   - prism.subscription.*  — same UCI sections Expert's Nodes tab uses, so
//                             subscriptions added here show up there.
//   - prism.basic.server    — list of node tags the user selected; build-config's
//                             basic path turns N=1 into the final outbound and
//                             N>1 into a urltest tagged basic-auto.
//   - prism.basic.routing   — "all" | "bypass_country"
//   - prism.basic.bypass_country — ISO code (curated list below)
//   - prism.basic.ports     — "all" | "common"
//
// Custom rules, manual outbounds and /etc/prism/extra.json are kept on disk
// but not compiled while in Basic mode. The "advanced configuration present"
// banner below the form surfaces that state so the user is not surprised when
// switching back to Expert restores everything.

'use strict';
'require baseclass';
'require form';
'require rpc';
'require ui';
'require uci';
'require session';
'require view.prism.lib.formpanel as formpanel';

var callListSubNodes = rpc.declare({
	object: 'luci.prism',
	method: 'list_subscription_nodes',
	params: ['id'],
	expect: { '': { nodes: [] } }
});

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

var callHasAdvanced = rpc.declare({
	object: 'luci.prism',
	method: 'has_advanced_config',
	expect: { '': {} }
});

var callSetMode = rpc.declare({
	object: 'luci.prism',
	method: 'set_mode',
	params: ['mode'],
	expect: { '': {} }
});

// Curated, alphabetical-by-English-name country list for the bypass picker.
// Power users who need an obscure code switch to Expert mode.
var COUNTRIES = [
	['br', 'Brazil'], ['ca', 'Canada'], ['cn', 'China'], ['fr', 'France'],
	['de', 'Germany'], ['hk', 'Hong Kong'], ['in', 'India'], ['ir', 'Iran'],
	['it', 'Italy'], ['jp', 'Japan'], ['nl', 'Netherlands'], ['ru', 'Russia'],
	['sg', 'Singapore'], ['kr', 'South Korea'], ['es', 'Spain'], ['tw', 'Taiwan'],
	['tr', 'Turkey'], ['gb', 'United Kingdom'], ['us', 'United States']
];

return baseclass.extend({
	load: function() {
		// One UCI snapshot + one RPC per subscription for node listings + one
		// RPC for the advanced-config probe. The host already loaded prism;
		// re-loading is cheap (cached) and keeps the panel self-contained if
		// it is ever mounted standalone.
		return uci.load('prism').then(function() {
			// /etc/config/prism is a conffile preserved across upgrades, so
			// pre-basic-mode installs are missing the `config prism 'basic'`
			// section the new defaults ship. Without it form.NamedSection
			// renders the section header but skips every option underneath.
			// set_mode primes the section on the way into Basic; this is the
			// belt-and-suspenders fallback for hand-edited UCI state.
			if (uci.get('prism', 'basic') == null) {
				uci.add('prism', 'prism', 'basic');
			}
			var subs = uci.sections('prism', 'subscription');
			var calls = subs.map(function(sub) {
				return callListSubNodes(sub['.name']).catch(function() {
					return { nodes: [] };
				});
			});
			return Promise.all(calls).then(function(results) {
				// Clash-format subscriptions carry their own urltest /
				// selector groups alongside the individual nodes. Basic's
				// "pick N, auto-wrap in basic-auto" flow only makes sense
				// for concrete servers — wrapping a group inside another
				// group is valid in sing-box but confusing to surface in a
				// "Default server(s)" picker. Filter group types out here
				// so the dropdown only offers real endpoints.
				var GROUP_TYPES = { urltest: true, selector: true };
				var nodes = [];
				results.forEach(function(r, i) {
					var subId   = subs[i]['.name'];
					var subName = subs[i].name || subId;
					(r.nodes || []).forEach(function(n) {
						if (n.tag && !GROUP_TYPES[n.type]) nodes.push({
							tag: n.tag, sub_id: subId, sub_name: subName
						});
					});
				});
				return nodes;
			});
		}).then(function(nodes) {
			return callHasAdvanced().catch(function() {
				return { has: false };
			}).then(function(adv) {
				return { nodes: nodes, advanced: adv };
			});
		});
	},

	render: function(data) {
		var self = this;
		data = data || { nodes: [], advanced: { has: false } };
		this._hasAdvanced = !!(data.advanced && data.advanced.has);

		var m = new form.Map('prism');

		// ── Subscriptions ───────────────────────────────────────────────
		// Minimal columns vs. Expert's Nodes tab — no auto-update / UA /
		// last-sync clutter. Same UCI sections, so anything added here is
		// visible from Expert too.
		var sSubs = m.section(form.GridSection, 'subscription', _('Subscriptions'),
			_('Lists of nodes Prism downloads on a schedule.'));
		sSubs.addremove   = true;
		sSubs.anonymous   = true;
		sSubs.addbtntitle = _('Add subscription');
		sSubs.modaltitle  = function() { return _('Subscription'); };

		var oSubEnabled = sSubs.option(form.Flag, 'enabled', _('Enabled'));
		oSubEnabled["default"] = '1';
		oSubEnabled.rmempty    = false;
		oSubEnabled.editable   = true;

		var oSubName = sSubs.option(form.Value, 'name', _('Name'));
		oSubName.rmempty     = false;
		oSubName.placeholder = _('My subscription');

		var oSubCount = sSubs.option(form.DummyValue, 'node_count', _('Nodes'));
		oSubCount.modalonly = false;

		var oSubUrl = sSubs.option(form.Value, 'url', _('URL'));
		oSubUrl.modalonly    = true;
		oSubUrl.rmempty      = false;
		oSubUrl.placeholder  = 'https://example.com/sub';

		var oSubSync = sSubs.option(form.Button, '_sync', _('Sync'));
		oSubSync.modalonly  = false;
		oSubSync.editable   = true;
		oSubSync.inputtitle = _('Sync');
		oSubSync.inputstyle = 'apply';
		oSubSync.onclick = function(ev, section_id) {
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
				if (!ok) return;
				return callReloadIfChanged().then(function(r) {
					if (r && r.reloaded)
						ui.addNotification(null,
							E('p', _('Active node changed — sing-box reloaded.')), 'info');
					ui.hideModal();
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
				btn.textContent  = label;
				btn.classList.remove('spinning');
			});
		};

		// ── Default server(s) ───────────────────────────────────────────
		// All Basic-mode knobs share the prism.basic NamedSection. They are
		// split into three visual sections for readability.
		var sServer = m.section(form.NamedSection, 'basic', 'prism',
			_('Default server(s)'),
			_('Pick one server, or several. With several, sing-box auto-routes through whichever has the lowest latency.'));
		sServer.addremove = false;

		var oServer = sServer.option(form.MultiValue, 'server', _('Server'));
		// 'select' renders LuCI's checkbox-multi-select dropdown — same widget
		// Expert's urltest member picker uses, with a search field for long
		// node lists.
		oServer.widget = 'select';
		oServer.rmempty = true;
		oServer.placeholder = _('— pick one or more —');
		if (data.nodes.length === 0) {
			oServer.description = _('No nodes yet. Add a subscription and sync it first.');
		} else {
			data.nodes.forEach(function(n) {
				oServer.value(n.tag, n.tag + '  (' + n.sub_name + ')');
			});
		}

		// ── Routing ─────────────────────────────────────────────────────
		var sRouting = m.section(form.NamedSection, 'basic', 'prism', _('Routing'));
		sRouting.addremove = false;

		var oRouting = sRouting.option(form.ListValue, 'routing', _('Mode'));
		oRouting.value('all',            _('Proxy everything'));
		oRouting.value('bypass_country', _('Proxy everything except this country'));
		oRouting["default"] = 'all';

		var oCountry = sRouting.option(form.ListValue, 'bypass_country', _('Country to bypass'));
		COUNTRIES.forEach(function(c) { oCountry.value(c[0], _(c[1])); });
		oCountry["default"] = 'cn';
		oCountry.depends('routing', 'bypass_country');

		// ── Ports ───────────────────────────────────────────────────────
		var sPorts = m.section(form.NamedSection, 'basic', 'prism', _('Ports'));
		sPorts.addremove = false;

		var oPorts = sPorts.option(form.ListValue, 'ports', _('Mode'));
		oPorts.value('all',    _('Proxy all ports'));
		oPorts.value('common', _('Proxy only common ports (SSH, mail, DNS, web, messengers)'));
		oPorts["default"] = 'all';

		this.map = m;
		return m.render().then(L.bind(this._postRender, this));
	},

	// Append the advanced-present banner (when applicable) and the
	// bottom-of-panel "Switch to Expert mode" link below the form, before
	// the host's footer attaches.
	_postRender: function(formNode) {
		var self = this;

		// Breathing room between sections — the four Basic stacks
		// (Subscriptions / Default server(s) / Routing / Ports) sit on top
		// of each other with the LuCI default 0.5em gap, which reads as one
		// dense block. 2em margin-top on every .cbi-section pushes each
		// title down so the visual rhythm matches the conceptual grouping.
		// Scoped to .cbi-map.prism-basic to leave Expert layouts alone.
		formNode.classList.add('prism-basic');
		formNode.appendChild(E('style', {}, [
			'.cbi-map.prism-basic .cbi-section{margin-top:2em}'
		]));

		var extras = [];

		extras.push(E('div', {
			'class': 'cbi-section',
			'style': 'margin-top:1em; text-align:right; font-size:0.9em'
		}, [
			_('Need more control? '),
			E('a', {
				'href':  '#',
				'click': function(ev) {
					ev.preventDefault();
					self._switchToExpert();
				}
			}, [ _('Switch to Expert mode →') ])
		]));

		extras.forEach(function(el) { formNode.appendChild(el); });
		return formNode;
	},

	_switchToExpert: function() {
		return callSetMode('expert').then(function() {
			session.setLocalData('prism.activeTab', '');
			window.location.reload();
		}).catch(function(err) {
			ui.addNotification(null, E('p', _('Mode switch failed: ') +
				((err && err.message) ? err.message : err)), 'error');
		});
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	// GridSection edits are flushed to staging when their modal saves, so the
	// panel-level Reset must revert via ui.changes.revert() (see formpanel).
	handleReset:     function() { return formpanel.resetGrid(this); }
});

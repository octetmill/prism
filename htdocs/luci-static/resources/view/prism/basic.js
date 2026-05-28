// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Basic tab. Shown only when prism.global.mode = "basic"; the host view in
// main.js does the gating. The form binds to:
//
//   - prism.subscription.*  — same UCI sections Advanced's Nodes tab uses, so
//                             subscriptions added here show up there.
//   - prism.basic.server    — list of node tags the user selected; build-config's
//                             basic path turns N=1 into the final outbound and
//                             N>1 into a urltest tagged basic-auto.
//   - prism.basic.routing   — "all" | "bypass_country"
//   - prism.basic.bypass_country — ISO code (curated list below)
//   - prism.basic.ports     — "all" | "common"
//
// Custom rules, manual outbounds and /etc/prism/extra.json are kept on disk
// but not compiled while in Basic mode; switching back to Advanced restores
// them.

'use strict';
'require baseclass';
'require form';
'require rpc';
'require ui';
'require uci';
'require view.prism.lib.formpanel as formpanel';
'require view.prism.uid as uid';

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

// Curated, alphabetical-by-English-name country list for the bypass picker.
// Power users who need an obscure code switch to Advanced mode.
var COUNTRIES = [
	['br', 'Brazil'], ['ca', 'Canada'], ['cn', 'China'], ['fr', 'France'],
	['de', 'Germany'], ['hk', 'Hong Kong'], ['in', 'India'], ['ir', 'Iran'],
	['it', 'Italy'], ['jp', 'Japan'], ['nl', 'Netherlands'], ['ru', 'Russia'],
	['sg', 'Singapore'], ['kr', 'South Korea'], ['es', 'Spain'], ['tw', 'Taiwan'],
	['tr', 'Turkey'], ['gb', 'United Kingdom'], ['us', 'United States']
];

return baseclass.extend({
	load: function() {
		// One UCI snapshot + one RPC per subscription for node listings. The
		// host already loaded prism; re-loading is cheap (cached) and keeps
		// the panel self-contained if it is ever mounted standalone.
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
					// Mark the failure so the panel can surface it
					// instead of silently dropping the sub's servers
					// from the picker (which previously looked
					// indistinguishable from "this sub has no nodes").
					return { nodes: [], _failed: true };
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
				var failed = [];
				results.forEach(function(r, i) {
					var subId   = subs[i]['.name'];
					var subName = subs[i].name || subId;
					if (r._failed) { failed.push(subName); return; }
					(r.nodes || []).forEach(function(n) {
						if (n.tag && !GROUP_TYPES[n.type]) nodes.push({
							tag: n.tag, sub_id: subId, sub_name: subName
						});
					});
				});
				if (failed.length) {
					ui.addNotification(null, E('p',
						_('Could not load nodes from %d subscription(s): %s. ' +
						  'Try syncing them on the Subscriptions section.')
							.format(failed.length, failed.join(', '))),
						'warning');
				}
				return nodes;
			});
		});
	},

	render: function(nodes) {
		var self = this;
		nodes = nodes || [];

		var m = new form.Map('prism');

		// ── Subscriptions ───────────────────────────────────────────────
		// Minimal columns vs. Advanced's Nodes tab — no auto-update / UA /
		// last-sync clutter. Same UCI sections, so anything added here is
		// visible from Advanced too.
		var sSubs = m.section(form.GridSection, 'subscription', _('Subscriptions'),
			_('Lists of nodes Prism downloads on a schedule.'));
		sSubs.addremove   = true;
		sSubs.anonymous   = true;
		sSubs.addbtntitle = _('Add subscription');
		sSubs.modaltitle  = function() { return _('Subscription'); };

		// Create every subscription as a NAMED section whose name is a
		// random 16-hex uid — same scheme as the Advanced Nodes panel.
		// /etc/prism/nodes/<uid>.json is keyed by that name.
		var subsHandleAdd = sSubs.handleAdd;
		sSubs.handleAdd = function(ev, name) {
			return subsHandleAdd.call(this, ev, name || uid.generate());
		};

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

		// Silent 12h auto-refresh for any subscription created from Basic.
		// sync-subscriptions skips subs with auto_update unset or 0, so without
		// this default a Basic user would never get an automatic refresh — they
		// would have to switch to Advanced and toggle it on, which defeats the
		// "set it and forget it" promise. HiddenValue keeps the UI sparse;
		// rmempty=false so the explicit '12' lands in UCI (rmempty=true would
		// let LuCI drop the option when value == default, oscillating with the
		// cron path). Existing subs imported from Advanced keep their saved
		// value untouched.
		var oSubAuto = sSubs.option(form.HiddenValue, 'auto_update');
		oSubAuto["default"] = '12';
		oSubAuto.rmempty    = false;
		oSubAuto.modalonly  = true;

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
		// Advanced's urltest member picker uses, with a search field for long
		// node lists.
		oServer.widget = 'select';
		oServer.rmempty = true;
		oServer.placeholder = _('— pick one or more —');
		if (nodes.length === 0) {
			oServer.description = _('No nodes yet. Add a subscription and sync it first.');
		} else {
			nodes.forEach(function(n) {
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

		// Surface the single Advanced flag worth exposing in Basic: the
		// clash API drives the Status panel's Traffic row and the per-group
		// active-node display. Without this control, a user who enabled it
		// in Advanced and then switched to Basic would have no way to turn
		// it off (Settings tab is hidden). Bound to prism.global like the
		// Advanced version, so toggling in either mode shows the other.
		var sStats = m.section(form.NamedSection, 'global', 'prism', _('Status panel'));
		sStats.addremove = false;
		var oClash = sStats.option(form.Flag, 'clash_api_enabled',
			_('Show traffic and active-node stats'),
			_('Adds a loopback-only listener to sing-box (127.0.0.1:9090, ' +
			  'never on the LAN) so the Status panel can display live ' +
			  'throughput and which proxy node is currently active.'));
		oClash.rmempty = false;

		this.map = m;
		return m.render().then(L.bind(this._postRender, this));
	},

	// Append the advanced-present banner (when applicable) and the
	// bottom-of-panel "Switch to Advanced mode" link below the form, before
	// the host's footer attaches.
	_postRender: function(formNode) {
		var self = this;

		// Breathing room between sections — the four Basic stacks
		// (Subscriptions / Default server(s) / Routing / Ports) sit on top
		// of each other with the LuCI default 0.5em gap, which reads as one
		// dense block. 2em margin-top on every .cbi-section pushes each
		// title down so the visual rhythm matches the conceptual grouping.
		// Scoped to .cbi-map.prism-basic to leave Advanced layouts alone.
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
					self._switchToAdvanced();
				}
			}, [ _('Switch to Advanced mode →') ])
		]));

		extras.forEach(function(el) { formNode.appendChild(el); });
		return formNode;
	},

	_switchToAdvanced: function() {
		// Delegate to the host: main.js owns set_mode plus the
		// unsaved-changes warning and the staged-changes revert step.
		// _prismHost is set by main.js _activate when the panel mounts.
		if (this._prismHost && typeof this._prismHost._handleModeSwitch === 'function') {
			return this._prismHost._handleModeSwitch('advanced');
		}
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	// GridSection edits are flushed to staging when their modal saves, so the
	// panel-level Reset must revert via ui.changes.revert() (see formpanel).
	handleReset:     function() { return formpanel.resetGrid(this); }
});

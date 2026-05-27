// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Single-page host view. Prism is one menu entry; every former page is a
// panel mounted lazily into one cbi-map. This keeps the "Prism" title above
// a single in-view tab bar (LuCI only auto-renders a sibling tab bar when a
// menu node has siblings — with one entry there are none).

'use strict';
'require view';
'require ui';
'require dom';
'require rpc';
'require uci';
'require session';
'require view.prism.status as statusPanel';
'require view.prism.nodes as nodesPanel';
'require view.prism.routing as routingPanel';
'require view.prism.settings as settingsPanel';
'require view.prism.basic as basicPanel';

var TABS_EXPERT = [
	{ id: 'status',   label: _('Status'),   panel: statusPanel },
	{ id: 'nodes',    label: _('Nodes'),    panel: nodesPanel },
	{ id: 'routing',  label: _('Routing'),  panel: routingPanel },
	{ id: 'settings', label: _('Settings'), panel: settingsPanel }
];

var TABS_BASIC = [
	{ id: 'status', label: _('Status'), panel: statusPanel },
	{ id: 'basic',  label: _('Basic'),  panel: basicPanel  }
];

// Old tab ids encountered in saved session state, mapped to current top-level
// ids. Anything else falls through to the first tab. The pre-2026-05-22 ids
// subscriptions and outbounds were both rolled into one node-list tab.
// `basic` exists only in Basic mode and `nodes / routing / settings` only in
// Advanced — the mode-specific filter at the call site re-maps the cross-mode
// case (an id that exists in the old mode but not the new one) to the closest
// equivalent in the current mode.
var TAB_REDIRECT = {
	overview:      'status',
	diagnostics:   'status',
	outbounds:     'nodes',
	subscriptions: 'nodes',
	servers:       'nodes'
};

var callSetMode = rpc.declare({
	object: 'luci.prism',
	method: 'set_mode',
	params: ['mode'],
	expect: { '': {} }
});

return view.extend({
	// The host owns its own footers per active panel; suppress the framework one.
	handleSave:      null,
	handleSaveApply: null,
	handleReset:     null,

	load: function() {
		// The host owns the mode flag; each panel is mode-agnostic and just
		// renders. uci.load('prism') round-trips through rpcd once, then
		// every panel that reads UCI hits the cache.
		return uci.load('prism');
	},

	render: function() {
		this._mountGen = 0;
		this._mode = this._readMode();
		this._tabs = (this._mode === 'basic') ? TABS_BASIC : TABS_EXPERT;
		this._topMenu = E('ul', { 'class': 'cbi-tabmenu' }, []);
		this._content = E('div', { 'class': 'prism-tab-content' }, []);
		this._shell = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('Prism') ]),
			this._topMenu,
			this._content,
			this._renderModeStyles()
		]);

		var route = this._initialRoute();
		var self = this;
		return Promise.resolve(this._activate(route.group, route.sub)).then(function() {
			return self._shell;
		});
	},

	_readMode: function() {
		var m = uci.get('prism', 'global', 'mode');
		return (m === 'basic') ? 'basic' : 'advanced';
	},

	// Tabs that don't exist in the current mode get folded onto the closest
	// equivalent so a stored session id from the other mode still lands on
	// something sensible after a Save & Apply reload.
	_redirectForMode: function(id) {
		if (this._mode === 'basic') {
			if (id === 'nodes' || id === 'routing' || id === 'settings')
				return 'basic';
		} else {
			if (id === 'basic')
				return 'status';
		}
		return id;
	},

	// Save & Apply reloads the page; restore the last active tab from LuCI's
	// session store — the same mechanism the stock form-tab pages use to
	// survive an apply. No URL hash is involved.
	_initialRoute: function() {
		var raw = session.getLocalData('prism.activeTab') || '';
		var parts = raw.split('/');
		var group = parts[0] || this._tabs[0].id;
		// Redirect stored ids from prior layouts so a Save & Apply (which
		// reloads the page) lands on the equivalent merged tab instead of
		// silently falling back to the first tab.
		if (TAB_REDIRECT[group])
			group = TAB_REDIRECT[group];
		group = this._redirectForMode(group);
		// Old settings/<sub> ids now collapse to the single Settings tab.
		var sub = parts[1] || null;
		if (group === 'settings')
			sub = null;
		return { group: group, sub: sub };
	},

	_buildMenu: function(items, activeId, onClick) {
		var els = items.map(function(it) {
			return E('li', { 'class': it.id === activeId ? 'cbi-tab' : 'cbi-tab-disabled' }, [
				E('a', {
					'href': '#',
					'click': function(ev) { ev.preventDefault(); onClick(it.id); }
				}, [ it.label ])
			]);
		});
		els.push(this._buildModeChip());
		return els;
	},

	// Right-aligned mode toggle that lives inside the top tab bar (margin-left:
	// auto pushes it past the regular tabs). Text changes per mode: in Basic
	// it offers "Advanced mode →", in Advanced it offers "Basic mode →".
	// Switching back to Advanced is non-destructive (no confirm); switching to
	// Basic is also non-destructive — advanced config is kept on disk — but a
	// modal explains the new builder behaviour the first time the user flips
	// it from Advanced, so the change is never silent.
	_buildModeChip: function() {
		var self = this;
		var target = (this._mode === 'basic') ? 'advanced' : 'basic';
		var label  = (target === 'advanced')
			? _('Advanced mode →') : _('Basic mode →');
		return E('li', { 'class': 'prism-mode-chip' }, [
			E('a', {
				'href':  '#',
				'title': (target === 'advanced')
					? _('Show every Prism setting (Nodes, Routing, Settings tabs).')
					: _('Hide advanced settings. Your advanced configuration is kept on disk and returns when you switch back.'),
				'click': function(ev) {
					ev.preventDefault();
					self._handleModeSwitch(target);
				}
			}, [ label ])
		]);
	},

	_handleModeSwitch: function(target) {
		if (target === 'advanced') {
			return this._applyModeSwitch(target);
		}
		// Advanced → Basic: show the rules of the new mode once. The action
		// itself is non-destructive but the running config will change shape.
		ui.showModal(_('Switch to Basic mode?'), [
			E('p', {}, [ _(
				'Basic mode hides Nodes, Routing and Settings and builds the running ' +
				'sing-box config from the Basic tab only. Your advanced configuration ' +
				'is kept on disk and will be active again when you switch back to Advanced.'
			) ]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-apply',
					'click': ui.createHandlerFn(this, '_applyModeSwitch', target)
				}, [ _('Switch to Basic') ])
			])
		]);
	},

	_applyModeSwitch: function(target) {
		ui.hideModal();
		return callSetMode(target).then(function() {
			// Drop the stored tab id so the new mode lands on its first tab
			// cleanly instead of being redirected through the cross-mode map.
			session.setLocalData('prism.activeTab', '');
			window.location.reload();
		}).catch(function(err) {
			ui.addNotification(null, E('p', _('Mode switch failed: ') +
				((err && err.message) ? err.message : err)), 'error');
		});
	},

	_renderModeStyles: function() {
		return E('style', {}, [
			'.cbi-tabmenu .prism-mode-chip{margin-left:auto;border:none;background:none}' +
			'.cbi-tabmenu .prism-mode-chip a{padding:0.4em 0.6em;color:#666;' +
				'font-size:0.85em;text-decoration:none}' +
			'.cbi-tabmenu .prism-mode-chip a:hover{color:#000}'
		]);
	},

	_buildFooter: function(panel) {
		var hasApply = (typeof panel.handleSaveApply === 'function');
		var hasSave  = (typeof panel.handleSave === 'function');
		var hasReset = (typeof panel.handleReset === 'function');
		if (!hasApply && !hasSave && !hasReset)
			return null;

		return E('div', { 'class': 'cbi-page-actions' }, [
			hasApply ? E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(panel, 'handleSaveApply')
			}, [ _('Save & Apply') ]) : '',
			hasSave ? E('button', {
				'class': 'btn cbi-button cbi-button-save',
				'click': ui.createHandlerFn(panel, 'handleSave')
			}, [ _('Save') ]) : '',
			hasReset ? E('button', {
				'class': 'btn cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(panel, 'handleReset')
			}, [ _('Reset') ]) : ''
		]);
	},

	// Re-mount the currently active panel (used by panels after an async
	// action — e.g. a subscription sync — changes UCI out of band).
	remountActive: function() {
		return this._activate(this._activeGroup, this._activeSub);
	},

	_activate: function(groupId, subId) {
		var self = this;
		var gen = ++this._mountGen;

		if (this._panel && typeof this._panel._teardown === 'function') {
			try { this._panel._teardown(); } catch (e) {}
		}
		this._panel = null;

		var group = this._tabs.filter(function(t) { return t.id === groupId; })[0] || this._tabs[0];
		groupId = group.id;

		var leaf = group, sub = null;
		if (group.children) {
			sub = group.children.filter(function(c) { return c.id === subId; })[0]
				|| group.children[0];
			subId = sub.id;
			leaf = sub;
		} else {
			subId = null;
		}
		this._activeGroup = groupId;
		this._activeSub = subId;
		session.setLocalData('prism.activeTab',
			groupId + (subId ? '/' + subId : ''));

		dom.content(this._topMenu, this._buildMenu(this._tabs, groupId, function(id) {
			self._activate(id, null);
		}));

		var mountTarget;
		if (group.children) {
			var subMenu = E('ul', { 'class': 'cbi-tabmenu' },
				this._buildMenu(group.children, subId, function(id) {
					self._activate(groupId, id);
				}));
			mountTarget = E('div', { 'class': 'prism-subtab-content' }, []);
			dom.content(this._content, [ subMenu, mountTarget ]);
		} else {
			dom.content(this._content, []);
			mountTarget = this._content;
		}

		if (this._footer && this._footer.parentNode)
			this._footer.parentNode.removeChild(this._footer);
		this._footer = null;

		// LuCI's require() returns an already-constructed singleton, not a
		// class — use the panel instance directly (do not `new` it). Reuse
		// across activations is safe: switches are sequential and each
		// render() rebuilds the panel's DOM and state.
		var panel = leaf.panel;
		panel._prismHost = this;
		this._panel = panel;

		dom.content(mountTarget, E('div', { 'class': 'spinning' }, [ _('Loading…') ]));

		return Promise.resolve().then(function() {
			return (typeof panel.load === 'function') ? panel.load() : null;
		}).then(function(data) {
			if (gen !== self._mountGen) return;
			return Promise.resolve(panel.render(data)).then(function(node) {
				if (gen !== self._mountGen) return;
				dom.content(mountTarget, node);
				var footer = self._buildFooter(panel);
				if (footer) {
					self._footer = footer;
					self._shell.appendChild(footer);
				}
			});
		}).catch(function(err) {
			if (gen !== self._mountGen) return;
			dom.content(mountTarget, E('div', { 'class': 'alert-message warning' }, [
				_('Failed to load this tab: ') + (err && err.message ? err.message : err)
			]));
		});
	}
});

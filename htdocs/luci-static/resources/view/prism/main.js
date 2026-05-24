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
'require session';
'require view.prism.status as statusPanel';
'require view.prism.nodes as nodesPanel';
'require view.prism.routing as routingPanel';
'require view.prism.settings as settingsPanel';

var TABS = [
	{ id: 'status',   label: _('Status'),   panel: statusPanel },
	{ id: 'nodes',    label: _('Nodes'),    panel: nodesPanel },
	{ id: 'routing',  label: _('Routing'),  panel: routingPanel },
	{ id: 'settings', label: _('Settings'), panel: settingsPanel }
];

// Old tab ids encountered in saved session state, mapped to current top-level
// ids. Anything else falls through to TABS[0]. The pre-2026-05-22 ids
// subscriptions and outbounds were both rolled into one node-list tab.
var TAB_REDIRECT = {
	overview:      'status',
	diagnostics:   'status',
	outbounds:     'nodes',
	subscriptions: 'nodes',
	servers:       'nodes'
};

return view.extend({
	// The host owns its own footers per active panel; suppress the framework one.
	handleSave:      null,
	handleSaveApply: null,
	handleReset:     null,

	load: function() {
		return Promise.resolve();
	},

	render: function() {
		this._mountGen = 0;
		this._topMenu = E('ul', { 'class': 'cbi-tabmenu' }, []);
		this._content = E('div', { 'class': 'prism-tab-content' }, []);
		this._shell = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('Prism') ]),
			this._topMenu,
			this._content
		]);

		var route = this._initialRoute();
		var self = this;
		return Promise.resolve(this._activate(route.group, route.sub)).then(function() {
			return self._shell;
		});
	},

	// Save & Apply reloads the page; restore the last active tab from LuCI's
	// session store — the same mechanism the stock form-tab pages use to
	// survive an apply. No URL hash is involved.
	_initialRoute: function() {
		var raw = session.getLocalData('prism.activeTab') || '';
		var parts = raw.split('/');
		var group = parts[0] || TABS[0].id;
		// Redirect stored ids from prior layouts so a Save & Apply (which
		// reloads the page) lands on the equivalent merged tab instead of
		// silently falling back to TABS[0].
		if (TAB_REDIRECT[group])
			group = TAB_REDIRECT[group];
		// Old settings/<sub> ids now collapse to the single Settings tab.
		var sub = parts[1] || null;
		if (group === 'settings')
			sub = null;
		return { group: group, sub: sub };
	},

	_buildMenu: function(items, activeId, onClick) {
		return items.map(function(it) {
			return E('li', { 'class': it.id === activeId ? 'cbi-tab' : 'cbi-tab-disabled' }, [
				E('a', {
					'href': '#',
					'click': function(ev) { ev.preventDefault(); onClick(it.id); }
				}, [ it.label ])
			]);
		});
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

		var group = TABS.filter(function(t) { return t.id === groupId; })[0] || TABS[0];
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

		dom.content(this._topMenu, this._buildMenu(TABS, groupId, function(id) {
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

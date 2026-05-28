// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

'use strict';
'require baseclass';
'require form';
'require uci';
'require rpc';
'require ui';
'require view.prism.lib.ordersave as ordersave';
'require view.prism.lib.formpanel as formpanel';
'require view.prism.uid as uid';

var callListOutbounds = rpc.declare({
	object: 'luci.prism',
	method: 'list_outbounds',
	expect: { '': {} }
});

var callListRulesets = rpc.declare({
	object: 'luci.prism',
	method: 'list_rulesets',
	expect: { '': {} }
});

var callRefreshRulesets = rpc.declare({
	object: 'luci.prism',
	method: 'refresh_rulesets',
	expect: { '': {} }
});

// Catalog refresh is the once-a-week background fetch from GitHub. It used
// to be implicit in list_rulesets (any read triggered the refresh on stale
// cache), but that put outbound network requests on the ACL read side. Now
// the load() call asks for the cached data, then explicitly requests a
// refresh only when the cache is older than the TTL. The refresh is
// fire-and-forget; the next page load picks up the new names.
var RULESET_CACHE_TTL_S = 7 * 24 * 3600;

var callListDhcpLeases = rpc.declare({
	object: 'luci.prism',
	method: 'list_dhcp_leases',
	expect: { '': {} }
});

// Sniffed application protocols sing-box can match on. Endpoint-only match
// dimensions (process, package, user, wifi) are deliberately not exposed —
// they are invisible for traffic forwarded from LAN clients.
var PROTOCOLS = [
	'tls', 'http', 'quic', 'dns', 'stun',
	'bittorrent', 'dtls', 'ssh', 'rdp', 'ntp'
];

// A routing rule's destination is an ordered list of conditions, each of one
// of these kinds. domain* / ip_cidr / protocol / port are native sing-box
// matchers; ruleset resolves to a rule-set reference.
var KINDS = [
	[ 'domain',         _('Domain (exact)') ],
	[ 'domain_suffix',  _('Domain suffix')  ],
	[ 'domain_keyword', _('Domain keyword') ],
	[ 'domain_regex',   _('Domain regex')   ],
	[ 'ip_cidr',        _('IP / CIDR')      ],
	[ 'ruleset',        _('Rule-set')       ],
	[ 'protocol',       _('Protocol')       ],
	[ 'port',           _('Port')           ]
];

var KIND_SHORT = {
	domain:         _('domain'),
	domain_suffix:  _('suffix'),
	domain_keyword: _('keyword'),
	domain_regex:   _('regex'),
	ip_cidr:        _('IP'),
	ruleset:        _('rule-set'),
	protocol:       _('protocol'),
	port:           _('port')
};

var PLACEHOLDERS = {
	domain:         'example.com',
	domain_suffix:  '.example.com',
	domain_keyword: 'example',
	domain_regex:   '.*\\.example\\.com$',
	ip_cidr:        '192.0.2.0/24',
	ruleset:        'sagernet/geosite-cn',
	protocol:       'tls',
	port:           '80, 443, 8000-8100'
};

// Custom autocomplete popup. The native <datalist> opens on focus, shows
// every option, and on some browsers expands into a full-screen overlay —
// useless for a 100+ entry rule-set catalog. This is a single shared popup
// that filters by substring, opens only after AC_MIN_CHARS, caps the
// visible height at ~10 rows, and scrolls for the rest.
var AC_MIN_CHARS  = 2;
var AC_MAX_HITS   = 200;  // result pool; popup window is height-bounded
var acPopup = null;
var acState = null;       // { input, items: [str], active: idx }

function acClose() {
	if (acPopup) acPopup.style.display = 'none';
	acState = null;
}

function acGetPopup() {
	if (acPopup) return acPopup;
	acPopup = E('div', {
		'class': 'prism-ac-popup',
		'style': 'position:fixed; z-index:10000; display:none; ' +
		         'max-height:240px; overflow-y:auto; min-width:12em; ' +
		         'background:var(--background-color-medium, #fff); ' +
		         'color:var(--text-color-medium, inherit); ' +
		         'border:1px solid var(--border-color-medium, #888); ' +
		         'box-shadow:0 2px 6px rgba(0,0,0,0.25); ' +
		         'font-size:13px;'
	});
	document.body.appendChild(acPopup);
	document.addEventListener('mousedown', function(ev) {
		if (!acState) return;
		if (acPopup.contains(ev.target) || ev.target === acState.input) return;
		acClose();
	});
	// Close on scroll of any ancestor — the popup is fixed-positioned so a
	// scroll underneath would otherwise leave it stranded. Scrolls inside
	// the popup itself (its own overflow container) must NOT trigger this.
	window.addEventListener('scroll', function(ev) {
		if (acPopup && acPopup.contains(ev.target)) return;
		acClose();
	}, true);
	window.addEventListener('resize', acClose);
	return acPopup;
}

function acSetActive(i) {
	if (!acState) return;
	var pop = acGetPopup();
	if (i < 0 || i >= pop.children.length) return;
	acState.active = i;
	for (var k = 0; k < pop.children.length; k++) {
		pop.children[k].style.background = (k === i)
			? 'var(--background-color-high, #d0d8e0)' : '';
	}
	pop.children[i].scrollIntoView({ block: 'nearest' });
}

function acSelect(i) {
	if (!acState) return;
	var input = acState.input;
	input.value = acState.items[i];
	input.dispatchEvent(new Event('input',  { bubbles: true }));
	input.dispatchEvent(new Event('change', { bubbles: true }));
	acClose();
	input.focus();
}

function acOpen(input, items) {
	var pop = acGetPopup();
	while (pop.firstChild) pop.removeChild(pop.firstChild);
	items.forEach(function(it, i) {
		var entry = E('div', {
			'class': 'prism-ac-item',
			'style': 'padding:4px 8px; cursor:pointer; white-space:nowrap;'
		}, [ it ]);
		entry.addEventListener('mouseenter', function() { acSetActive(i); });
		entry.addEventListener('mousedown', function(ev) {
			ev.preventDefault();  // keep input focused
			acSelect(i);
		});
		pop.appendChild(entry);
	});
	var rect = input.getBoundingClientRect();
	pop.style.left     = rect.left + 'px';
	pop.style.top      = (rect.bottom + 2) + 'px';
	pop.style.minWidth = rect.width + 'px';
	pop.style.display  = 'block';
	acState = { input: input, items: items, active: 0 };
	acSetActive(0);
}

function bindAutocomplete(input, suggestions) {
	if (!input || input._prismAcBound) return;
	input._prismAcBound = true;

	// Normalise once: suggestions may be plain strings or [value, label] pairs.
	var pool = suggestions.map(function(s) {
		return Array.isArray(s) ? s[0] : s;
	});

	function refresh() {
		var q = (input.value || '').trim().toLowerCase();
		if (q.length < AC_MIN_CHARS) { acClose(); return; }
		var hits = [];
		for (var k = 0; k < pool.length && hits.length < AC_MAX_HITS; k++) {
			if (pool[k].toLowerCase().indexOf(q) !== -1)
				hits.push(pool[k]);
		}
		if (!hits.length) { acClose(); return; }
		acOpen(input, hits);
	}

	input.addEventListener('input', refresh);
	input.addEventListener('blur', function() {
		// Delay so mousedown on a popup row can fire and select first.
		setTimeout(function() {
			if (acState && acState.input === input &&
			    document.activeElement !== input)
				acClose();
		}, 150);
	});
	input.addEventListener('keydown', function(ev) {
		if (!acState || acState.input !== input) return;
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			acSetActive(Math.min(acState.active + 1,
			                     acState.items.length - 1));
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			acSetActive(Math.max(acState.active - 1, 0));
		} else if (ev.key === 'Enter') {
			ev.preventDefault();
			acSelect(acState.active);
		} else if (ev.key === 'Escape') {
			acClose();
		}
	});
}

// Human label for one condition — the short kind name, prefixed with NOT
// when inverted. Shared by the grid summary and the modal preview so the
// two renderings never diverge.
function condLabel(kind, invert) {
	return (invert ? _('NOT') + ' ' : '') + (KIND_SHORT[kind] || kind);
}

// Read the `condition` child sections belonging to a rule, ordered. Each
// condition is a UCI section of type `condition` with a `rule` back-reference.
function readConditions(rule_name) {
	var list = uci.sections('prism', 'condition').filter(function(c) {
		return c.rule === rule_name;
	});
	list.sort(function(a, b) {
		return (parseInt(a.order, 10) || 0) - (parseInt(b.order, 10) || 0);
	});
	return list.map(function(c) {
		var v = c.value;
		var values = Array.isArray(v) ? v.slice()
			: (v != null && v !== '') ? [ v ] : [];
		return {
			kind:   c.kind || 'domain_suffix',
			op:     (c.op === 'and') ? 'and' : 'or',
			invert: (c.invert === '1'),
			values: values
		};
	});
}

// Short human summary of a rule's conditions for the grid column.
function ruleSummary(rule_name) {
	var conds = readConditions(rule_name);
	if (!conds.length)
		return _('no conditions (skipped)');
	if (conds.length > 4)
		return _('%d conditions').format(conds.length);
	var parts = [];
	conds.forEach(function(c, i) {
		if (i > 0)
			parts.push(c.op === 'and' ? _('AND') : _('OR'));
		parts.push(condLabel(c.kind, c.invert));
	});
	return parts.join(' ');
}

// Custom modal widget: the editable list of conditions for one rule. It is
// backed by child `condition` UCI sections rather than a field on the rule,
// so `cfgvalue` reads them and `parse` reconciles them. form.DummyValue is
// the base — it carries no input/validation machinery to clash with the
// fully custom `parse`. The suggestion sets (rsSuggest / protoSuggest) are
// assigned per-instance in render(), once the rule-set catalog has loaded.
var ConditionList = form.DummyValue.extend({
	cfgvalue: function(section_id) {
		return readConditions(section_id);
	},

	renderWidget: function(section_id) {
		var rsSuggest    = this.rsSuggest    || null;
		var protoSuggest = this.protoSuggest || null;

		var rowsEl  = E('div', {});
		var preview = E('div', {
			'style': 'margin-top:8px; font-style:italic; opacity:0.75'
		});

		function suggestionsFor(kind) {
			if (kind === 'ruleset')  return rsSuggest;
			if (kind === 'protocol') return protoSuggest;
			return null;
		}

		// Build a value editor for one condition kind. Returns { node, get }:
		// `node` is mounted in the row, `get()` returns the value array.
		//
		// `port` gets a single text input — comma-separated ports, `lo-hi`
		// for ranges (80, 443, 8000-8100) — which suits short tokens far
		// better than a growable list. Every other kind keeps a
		// free-typeable ui.DynamicList; a custom autocomplete popup
		// (see bindAutocomplete) offers suggestions for the kinds that
		// have them without blocking arbitrary values.
		function makeValueEditor(kind, values) {
			if (kind === 'port') {
				var inp = E('input', {
					'type':        'text',
					'class':       'cbi-input-text',
					'style':       'width:100%',
					'placeholder': PLACEHOLDERS.port,
					'value':       (values || []).join(', ')
				});
				return {
					node: inp,
					get: function() {
						return inp.value.split(',').map(function(s) {
							return s.trim();
						}).filter(function(s) { return s !== ''; });
					}
				};
			}

			var dl   = new ui.DynamicList(values, null, {
				placeholder: PLACEHOLDERS[kind] || ''
			});
			var node = dl.render();
			var sugg = suggestionsFor(kind);
			if (sugg && sugg.length) {
				var bind = function(inp) {
					if (inp && inp.tagName === 'INPUT' && inp.type === 'text')
						bindAutocomplete(inp, sugg);
				};
				node.querySelectorAll('input[type="text"]').forEach(bind);
				// ui.DynamicList grows new inputs as items are added; bind
				// each one the first time it receives focus.
				node.addEventListener('focusin', function(ev) {
					bind(ev.target);
				});
			}
			return {
				node: node,
				get: function() {
					var v = dl.getValue();
					if (!Array.isArray(v))
						v = (v != null && v !== '') ? [ v ] : [];
					return v.filter(function(x) {
						return x != null && x !== '';
					});
				}
			};
		}

		// Hide the first row's operator (nothing precedes it) and render a
		// plain-text preview of the parsed grouping. AND binds tighter than
		// OR, so the rule is an OR of AND-runs — the preview brackets each
		// multi-condition run so the precedence is never a surprise.
		function refresh() {
			var rows = rowsEl.querySelectorAll('.prism-cond-row');
			var runs = [];
			rows.forEach(function(row, i) {
				row.querySelector('.prism-cond-op').style.display =
					(i === 0) ? 'none' : '';
				var info  = row._prismRow;
				var label = condLabel(info.kindSel.value,
				                      info.notSel.value === 'not');
				if (i === 0 || info.opSel.value === 'or')
					runs.push([ label ]);
				else
					runs[runs.length - 1].push(label);
			});
			if (!runs.length) {
				preview.textContent =
					_('No conditions — this rule does nothing and is skipped.');
				return;
			}
			var txt = runs.map(function(run) {
				return (run.length > 1)
					? '(' + run.join(' ' + _('AND') + ' ') + ')'
					: run[0];
			}).join(' ' + _('OR') + ' ');
			preview.textContent = _('Matches: %s').format(txt);
		}

		function addRow(cond) {
			cond = cond || { kind: 'domain_suffix', op: 'and',
			                 invert: false, values: [] };

			var opSel = E('select', {
				'class': 'cbi-input-select',
				'style': 'width:5em'
			}, [
				E('option', { 'value': 'and' }, [ _('AND') ]),
				E('option', { 'value': 'or'  }, [ _('OR')  ])
			]);
			opSel.value = (cond.op === 'and') ? 'and' : 'or';
			opSel.addEventListener('change', refresh);

			var opLine = E('div', {
				'class': 'prism-cond-op',
				'style': 'margin:2px 0'
			}, [ opSel ]);

			// Per-condition NOT — a small "is / is not" select. Same element
			// type as the kind selector, so it lines up exactly. Compiles to
			// sing-box `invert` on this condition's match node.
			var notSel = E('select', {
				'class': 'cbi-input-select',
				'style': 'flex:0 0 6em'
			}, [
				E('option', { 'value': ''    }, [ _('is')     ]),
				E('option', { 'value': 'not' }, [ _('is not') ])
			]);
			notSel.value = cond.invert ? 'not' : '';
			notSel.addEventListener('change', refresh);

			var kindSel = E('select', {
				'class': 'cbi-input-select',
				'style': 'flex:0 0 11em'
			});
			KINDS.forEach(function(k) {
				kindSel.appendChild(E('option', { 'value': k[0] }, [ k[1] ]));
			});
			kindSel.value = cond.kind || 'domain_suffix';

			var ve = makeValueEditor(kindSel.value, cond.values || []);
			var valWrap = E('div', {
				'style': 'flex:1 1 auto; min-width:0'
			}, [ ve.node ]);

			// Swapping kind rebuilds the value editor to suit the new kind;
			// current values are carried across.
			kindSel.addEventListener('change', function() {
				ve = makeValueEditor(kindSel.value, ve.get());
				valWrap.removeChild(valWrap.firstChild);
				valWrap.appendChild(ve.node);
				refresh();
			});

			var rmBtn = E('button', {
				'class': 'btn cbi-button cbi-button-remove',
				'style': 'flex:0 0 auto',
				'click': function(ev) {
					ev.preventDefault();
					rowsEl.removeChild(row);
					refresh();
				}
			}, [ '✕' ]);

			// Kind first, then the is / is not selector, then the value —
			// the row reads as "<kind> is [not] <value>".
			var body = E('div', {
				'style': 'display:flex; gap:6px; align-items:flex-start'
			}, [ kindSel, notSel, valWrap, rmBtn ]);

			var row = E('div', {
				'class': 'prism-cond-row',
				'style': 'margin-bottom:6px'
			}, [ opLine, body ]);

			row._prismRow = {
				opSel:   opSel,
				kindSel: kindSel,
				notSel:  notSel,
				collect: function() {
					return {
						op:     opSel.value,
						kind:   kindSel.value,
						invert: (notSel.value === 'not'),
						values: ve.get()
					};
				}
			};

			rowsEl.appendChild(row);
			refresh();
		}

		(this.cfgvalue(section_id) || []).forEach(addRow);
		refresh();

		var addBtn = E('button', {
			'class': 'cbi-button cbi-button-add',
			'style': 'margin-top:4px',
			'click': function(ev) {
				ev.preventDefault();
				addRow();
			}
		}, [ _('Add condition') ]);

		var container = E('div', {}, [ rowsEl, addBtn, preview ]);

		// Keep a handle so parse() can find this rule's live editor DOM.
		this._editors = this._editors || {};
		this._editors[section_id] = container;
		return container;
	},

	// Reconcile this rule's child `condition` sections from the editor DOM.
	// It runs only when the editor is mounted (the rule's modal is open):
	// during a panel-level save no modal is open, and the conditions were
	// already written when the modal was saved. The isConnected guard also
	// makes the parse of every other rule during a modal save a no-op, so an
	// un-opened rule's conditions are never touched.
	parse: function(section_id) {
		var container = this._editors && this._editors[section_id];
		if (!container || !container.isConnected)
			return Promise.resolve();

		var desired = [];
		container.querySelectorAll('.prism-cond-row').forEach(function(row) {
			desired.push(row._prismRow.collect());
		});

		var existing = uci.sections('prism', 'condition').filter(function(c) {
			return c.rule === section_id;
		});
		existing.sort(function(a, b) {
			return (parseInt(a.order, 10) || 0) - (parseInt(b.order, 10) || 0);
		});

		// Skip the rewrite when nothing changed, so re-saving an untouched
		// modal stages no phantom UCI changes.
		function sig(kind, op, invert, vals) {
			return kind + '\x1f' + op + '\x1f' + (invert ? '1' : '') +
			       '\x1f' + vals.join('\x1e');
		}
		var same = (existing.length === desired.length);
		for (var i = 0; same && i < desired.length; i++) {
			var e  = existing[i];
			var ev = Array.isArray(e.value) ? e.value
				: (e.value != null && e.value !== '') ? [ e.value ] : [];
			if (sig(e.kind || '', i > 0 ? (e.op === 'and' ? 'and' : 'or') : '',
			        e.invert === '1', ev) !==
			    sig(desired[i].kind, i > 0 ? desired[i].op : '',
			        desired[i].invert, desired[i].values))
				same = false;
		}
		if (same)
			return Promise.resolve();

		existing.forEach(function(c) {
			uci.remove('prism', c['.name']);
		});
		desired.forEach(function(cd, idx) {
			var sid = uci.add('prism', 'condition', uid.generate());
			uci.set('prism', sid, 'rule',  section_id);
			uci.set('prism', sid, 'order', String(idx));
			uci.set('prism', sid, 'kind',  cd.kind);
			if (idx > 0)
				uci.set('prism', sid, 'op', cd.op);
			if (cd.invert)
				uci.set('prism', sid, 'invert', '1');
			if (cd.values.length)
				uci.set('prism', sid, 'value', cd.values);
		});
		return Promise.resolve();
	}
});

return baseclass.extend({
	load: function() {
		// A failed RPC must not kill the tab — degrade to empty data instead.
		return Promise.all([
			uci.load('prism'),
			callListOutbounds().catch(function() { return {}; }),
			callListRulesets().catch(function() { return {}; }),
			callListDhcpLeases().catch(function() { return {}; })
		]).then(function(results) {
			// Fire-and-forget catalog refresh if the cache is stale or absent.
			// Returns immediately; the next render() picks up the new names.
			var rs = results[2] || {};
			if (rs.age == null || rs.age > RULESET_CACHE_TTL_S) {
				callRefreshRulesets().catch(function() {});
			}
			return results;
		});
	},

	render: function(data) {
		var outbounds = (data && data[1] && Array.isArray(data[1].outbounds))
			? data[1].outbounds : [];

		// Autocomplete suggestions for the rule-set condition: "provider/name"
		// tokens from the fetched catalog, plus any custom rule-set labels.
		var rsNames = (data && data[2] && data[2].names) || {};
		var rsTokens = [];
		['sagernet', 'loyalsoldier', 'metacubex'].forEach(function(prov) {
			if (Array.isArray(rsNames[prov]))
				rsNames[prov].forEach(function(name) {
					rsTokens.push(prov + '/' + name);
				});
		});
		uci.sections('prism', 'customrs').forEach(function(cs) {
			if (cs.label) rsTokens.push(cs.label);
		});
		rsTokens.sort();

		// Map sub_id → human-readable name and display order. Two subscriptions
		// can carry nodes with identical tags; the label shown in the server
		// dropdown must make clear which subscription a tag comes from, and
		// the listing order must match the Servers tab's Subscriptions
		// section. Manual nodes (subscription === '') sort to the top, in
		// section order.
		// Keyed by the subscription's section name (its uid) — that is what
		// `ob.subscription` carries (the stable file key the rpcd handler
		// emits for every subscription node).
		var subName = {}, subOrder = {};
		uci.sections('prism', 'subscription').forEach(function(sub, idx) {
			var u = sub['.name'];
			subName[u]  = sub.name || u;
			subOrder[u] = idx;
		});
		function groupKey(sub_id) {
			if (!sub_id) return 0;
			if (sub_id in subOrder) return 1 + subOrder[sub_id];
			return Infinity;
		}

		// Returns the list of proxy (non-builtin) outbound tags in the same
		// order they were added to the widget. Callers that need to wire
		// `depends()` on "outbound is a proxy" use this to OR a clause for
		// each tag — LuCI has no "not equals" depends.
		function addServers(o) {
			o.value('direct', _('direct (no proxy)'));
			o.value('block',  _('block (drop)'));
			var entries = outbounds.map(function(ob, i) {
				var label = (ob.subscription && subName[ob.subscription])
					? subName[ob.subscription] + '/' + ob.tag
					: ob.tag;
				return {
					tag:   ob.tag,
					label: label,
					group: groupKey(ob.subscription),
					idx:   i
				};
			});
			entries.sort(function(a, b) {
				if (a.group !== b.group) return a.group - b.group;
				return a.idx - b.idx;
			});
			var tags = [];
			entries.forEach(function(e) {
				o.value(e.tag, e.label);
				tags.push(e.tag);
			});
			return tags;
		}

		var m = new form.Map('prism');

		// ── default node ────────────────────────────────────────────────
		var ds = m.section(form.NamedSection, 'routing', 'routing', _('Default node'),
			_('Node for traffic not matched by any rule below.'));
		ds.addremove = false;

		var oFinal = ds.option(form.ListValue, 'final_outbound', _('Default node'));
		addServers(oFinal);

		// ── rules ───────────────────────────────────────────────────────
		var s = m.section(form.GridSection, 'rule', _('Rules'),
			_('Evaluated top-to-bottom; first match wins. Each rule matches a ' +
			  'destination built from one or more conditions joined with ' +
			  'AND / OR, and sends matching traffic to a node. Changes ' +
			  'are staged until Save; Save & Apply also reloads the service.'));
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add');
		s.modaltitle = function() { return _('Routing rule'); };

		// Create each rule as a NAMED section whose name is a 16-hex uid.
		// Two reasons it has to be named (not anonymous): (a) a child
		// condition's `rule` back-reference captures the section name at
		// modal-save time, so the parent's name must be fixed from creation
		// — an anonymous section would commit as a fresh cfgXXXX and orphan
		// every just-saved condition; (b) all other anonymous types in this
		// config use uid-as-name too, so cross-references stay stable across
		// any structural change to /etc/config/prism. `anonymous` still
		// hides the name in the UI.
		var gridHandleAdd = s.handleAdd;
		s.handleAdd = function(ev, name) {
			return gridHandleAdd.call(this, ev, name || uid.generate());
		};

		var oEnabled = s.option(form.Flag, 'enabled', _('On'));
		oEnabled['default'] = '1';
		oEnabled.rmempty = false;
		oEnabled.editable = true;

		var oName = s.option(form.Value, 'name', _('Name'));
		oName.placeholder = _('Optional label');

		// Grid column only (modalonly === false): a read-only summary of the
		// rule's conditions. Kept out of the modal — the ConditionList editor
		// there already renders its own live preview.
		var oMatch = s.option(form.DummyValue, '_match', _('Conditions'));
		oMatch.modalonly = false;
		oMatch.cfgvalue = function(section_id) {
			return ruleSummary(section_id);
		};

		var oOut = s.option(form.ListValue, 'outbound', _('Node'));
		var proxyTags = addServers(oOut);
		// Render the node choice as an inline dropdown in the grid row so
		// rebinding a rule to a different node is one click, not a modal
		// open. The edit stays in-memory until the panel-level Save & Apply,
		// matching the inline Enabled checkbox above.
		oOut.editable = true;

		// Resolve this rule's domain matches through the same outbound the
		// connection takes — keeps the DNS lookup geo-consistent with the
		// traffic (matters for region-pinned CDNs like Netflix). build-config
		// emits a `remote-<outbound>` DNS server per flagged outbound. Only
		// shown when the picked node is an actual proxy; `direct` resolves
		// via `local` and `block` produces no DNS rule, so the flag is moot
		// for both. Default on.
		var oDns = s.option(form.Flag, 'dns_via_outbound',
			_('Resolve DNS via this node'),
			_('When on, domain matchers in this rule resolve through the same ' +
			  'outbound the connection uses, so CDN responses match the proxy ' +
			  'exit. Turn off to keep the lookup on the global Remote DNS.'));
		oDns['default'] = '1';
		oDns.rmempty = false;
		oDns.modalonly = true;
		proxyTags.forEach(function(t) { oDns.depends('outbound', t); });

		// ── Destination — the condition builder ──────────────────────────
		var oCond = s.option(ConditionList, '_conditions', _('Conditions'),
			_('Each condition matches one facet of the destination. Conditions ' +
			  'are joined by the AND / OR operator shown above each row; AND ' +
			  'binds tighter than OR, so a rule matches an OR of AND-groups ' +
			  '(see the preview below). Set a row to "is not" to invert it. ' +
			  'A rule with no conditions does nothing and is skipped — the ' +
			  'default server already handles otherwise-unmatched traffic.'));
		oCond.modalonly = true;
		oCond.rsSuggest    = rsTokens;
		oCond.protoSuggest = PROTOCOLS.slice().sort();

		// ── custom rule-sets ────────────────────────────────────────────
		// Lives in Routing because routing rules reference these by label;
		// the global delivery / download-detour knobs that used to sit next
		// to this section moved to Settings — they're set-once-and-forgotten
		// config, not something the user tweaks while editing rules.
		var cs = m.section(form.GridSection, 'customrs', _('Custom rule-sets'),
			_('Rule-sets fetched from an explicit URL. Reference one in a ' +
			  'routing rule by its label.'));
		cs.addremove = true;
		cs.anonymous = true;
		cs.addbtntitle = _('Add');

		// Uid-as-section-name (uniform with every other anonymous prism
		// type). Conditions reference rule-sets by their `label` field,
		// not by section name, so the change is cosmetic for customrs
		// alone — but it keeps the schema rule the same across the board.
		var csHandleAdd = cs.handleAdd;
		cs.handleAdd = function(ev, name) {
			return csHandleAdd.call(this, ev, name || uid.generate());
		};

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

		// ── bypass ──────────────────────────────────────────────────────
		// LAN clients listed here skip the proxy entirely — applied via
		// nftables `accept` rules at the head of the prerouting chain
		// (tproxy / tproxy_mixed modes), or as a source_ip_cidr direct
		// rule in the sing-box config (tun mode, IP entries only — MAC is
		// not visible at the IP layer the TUN device exposes, so MAC
		// entries are inert in tun mode and a warning is surfaced inline).
		var leases = (data && data[3] && Array.isArray(data[3].leases))
			? data[3].leases : [];
		var imode = uci.get('prism', 'inbounds', 'mode') || 'tproxy';

		var bp = m.section(form.GridSection, 'bypass', _('Bypass'),
			_('LAN clients listed here skip the proxy entirely. Useful for ' +
			  'devices that need direct WAN access (corporate VPN clients, ' +
			  'gaming consoles, IoT). MAC bypass requires TProxy or TProxy + ' +
			  'Mixed mode; IP bypass works in all modes.'));
		bp.addremove = true;
		bp.anonymous = true;
		bp.addbtntitle = _('Add');
		bp.modaltitle = function() { return _('Bypass'); };

		var bpHandleAdd = bp.handleAdd;
		bp.handleAdd = function(ev, name) {
			return bpHandleAdd.call(this, ev, name || uid.generate());
		};

		var bpEnabled = bp.option(form.Flag, 'enabled', _('On'));
		bpEnabled['default'] = '1';
		bpEnabled.rmempty = false;
		bpEnabled.editable = true;

		var bpName = bp.option(form.Value, 'name', _('Name'));
		bpName.placeholder = _('Optional label');

		var bpKind = bp.option(form.ListValue, 'kind', _('Type'));
		bpKind.value('mac', _('MAC'));
		bpKind.value('ip',  _('IP'));
		bpKind['default'] = 'mac';

		// Build the suggestion list for the Value combobox once per kind —
		// each DHCP lease contributes a single entry whose key matches the
		// chosen kind. The label leads with the hostname so filter-by-typing
		// works on the human name, and includes the "other" identifier as
		// secondary info.
		function bypassChoices(kind) {
			var keys = [], labels = {};
			leases.forEach(function(l) {
				var name  = l.hostname || _('(no hostname)');
				var key   = (kind === 'mac') ? l.mac : l.ip;
				var other = (kind === 'mac') ? l.ip  : l.mac;
				if (!key || key === '') return;
				keys.push(key);
				labels[key] = name + ' — ' + key + ' (' + other + ')';
			});
			return [keys, labels];
		}

		var bpValue = bp.option(form.Value, 'value', _('Value'));
		bpValue.rmempty = false;
		bpValue.placeholder = '00:11:22:33:44:55';
		// form.Value falls back to a plain ui.Textfield when no .value()
		// entries are declared at construction; force a ui.Combobox so
		// addChoices / clearChoices are available for the kind-driven
		// repopulation below. Initial choices are seeded asynchronously
		// once the modal is mounted (a setTimeout(0) — at the synchronous
		// render pass the cloned-modal option's data hasn't been hydrated
		// yet, so we render an empty widget and populate it one tick later).
		bpValue.renderWidget = function(section_id, option_index, cfgvalue) {
			var widget = new ui.Combobox(cfgvalue != null ? cfgvalue : '', {}, {
				id:          this.cbid(section_id),
				sort:        false,
				optional:    false,
				placeholder: this.placeholder,
				validate:    this.getValidator(section_id),
				disabled:    this.map.readonly
			});
			var node = widget.render();
			var self = this;
			setTimeout(function() {
				var w = self.getUIElement(section_id);
				if (!w) return;
				var kindOpts = self.map.lookupOption('kind', section_id);
				var kind = (kindOpts && kindOpts[0])
					? (kindOpts[0].formvalue(section_id) || 'mac') : 'mac';
				var c = bypassChoices(kind);
				w.clearChoices(true);
				w.addChoices(c[0], c[1]);
			}, 0);
			return node;
		};
		// Repopulate the Value combobox when the user flips MAC ↔ IP, so
		// the visible suggestions always match the current kind. Same
		// cross-map rule as servers.js: inside the modal `this.map` is the
		// clone, lookupOption finds the modal's sibling, getUIElement
		// returns the live widget.
		bpKind.onchange = function(ev, section_id, value) {
			var bpValueOpts = this.map.lookupOption('value', section_id);
			var opt = bpValueOpts && bpValueOpts[0];
			if (!opt) return;
			var w = opt.getUIElement(section_id);
			if (!w || typeof w.clearChoices !== 'function') return;
			var c = bypassChoices(value);
			w.clearChoices(true);
			w.addChoices(c[0], c[1]);
		};

		bpValue.validate = function(section_id, value) {
			if (!value || value === '')
				return _('A value is required.');
			var kindOpts = this.map.lookupOption('kind', section_id);
			var kind = (kindOpts && kindOpts[0])
				? (kindOpts[0].formvalue(section_id) || 'mac') : 'mac';
			if (kind === 'mac') {
				// nft only accepts colon-separated MACs; reject '-' and '.'
				// up front so saved values match firewall.sh's regex.
				if (!/^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(value))
					return _('Not a valid MAC address.');
			} else if (value.indexOf(':') === -1) {
				// IPv4 dotted-quad. Octet-range check rejects '999.999...'.
				var m = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/);
				if (!m)
					return _('Not a valid IP address.');
				for (var i = 1; i <= 4; i++)
					if (parseInt(m[i], 10) > 255)
						return _('Not a valid IP address.');
				if (m[5] != null && parseInt(m[5], 10) > 32)
					return _('Prefix length must be 0–32 for IPv4.');
			} else {
				// IPv6 shape check matching firewall.sh's nft validator:
				// 2–7 colons, hex groups up to 4 chars, optional /prefix.
				if (!/^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/\d{1,3})?$/.test(value))
					return _('Not a valid IPv6 address.');
				var pm = value.match(/\/(\d+)$/);
				if (pm && parseInt(pm[1], 10) > 128)
					return _('Prefix length must be 0–128 for IPv6.');
			}
			return true;
		};

		// Grid-only column: warn when a MAC entry won't fire because the
		// current inbound mode is `tun`. Empty cell otherwise — invisible
		// in the common (tproxy) case.
		var bpWarn = bp.option(form.DummyValue, '_warn', '');
		bpWarn.modalonly = false;
		bpWarn.cfgvalue = function(section_id) {
			var kind = uci.get('prism', section_id, 'kind') || 'mac';
			if (kind === 'mac' && imode === 'tun')
				return E('span', { 'class': 'label-warning',
					'style': 'padding:1px 6px; border-radius:3px;',
					'title': _('MAC bypass requires TProxy or TProxy + Mixed mode')
				}, [ _('⚠ TUN mode: ignored') ]);
			return '';
		};

		this.map = m;
		// Renumber rule `order` from section position, ensure the routing
		// NamedSection exists, and sweep `condition` sections orphaned by a
		// deleted rule — on every save path.
		ordersave.install(m, 'rule', function() {
			if (!uci.get('prism', 'routing'))
				uci.add('prism', 'routing', 'routing');

			var liveRules = {};
			uci.sections('prism', 'rule').forEach(function(r) {
				liveRules[r['.name']] = true;
			});
			uci.sections('prism', 'condition').forEach(function(c) {
				if (!c.rule || !liveRules[c.rule])
					uci.remove('prism', c['.name']);
			});
		});
		return m.render().then(function(node) {
			// Breathing room between the rules grid's Add button and the
			// Rule-set sources section. NamedSection renders its h3 and
			// description outside the `#cbi-{config}-{name}` options wrapper,
			// so a margin on that wrapper only pushed the options down —
			// target the heading by its text instead, which pushes the whole
			// visual block down.
			var gaps = { };
			gaps[_('Rules')]            = '2em';
			gaps[_('Custom rule-sets')] = '2em';
			gaps[_('Bypass')]           = '2em';
			node.querySelectorAll('h3').forEach(function(h) {
				var g = gaps[h.textContent];
				if (g) h.style.marginTop = g;
			});
			return node;
		});
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.resetGrid(this); }
});

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

// Sniffed application protocols sing-box can match on. Endpoint-only match
// dimensions (process, package, user, wifi) are deliberately not exposed —
// they are invisible for traffic forwarded from LAN clients.
var PROTOCOLS = [
	'tls', 'http', 'quic', 'dns', 'stun',
	'bittorrent', 'dtls', 'ssh', 'rdp', 'ntp'
];

var COUNTRIES = [
	['cn', 'China (cn)'],          ['us', 'United States (us)'],
	['gb', 'United Kingdom (gb)'], ['de', 'Germany (de)'],
	['fr', 'France (fr)'],         ['ru', 'Russia (ru)'],
	['jp', 'Japan (jp)'],          ['kr', 'South Korea (kr)'],
	['hk', 'Hong Kong (hk)'],      ['tw', 'Taiwan (tw)'],
	['sg', 'Singapore (sg)'],      ['in', 'India (in)'],
	['ir', 'Iran (ir)'],           ['br', 'Brazil (br)'],
	['au', 'Australia (au)'],      ['ca', 'Canada (ca)'],
	['it', 'Italy (it)'],          ['es', 'Spain (es)'],
	['nl', 'Netherlands (nl)'],    ['se', 'Sweden (se)'],
	['ch', 'Switzerland (ch)'],    ['tr', 'Turkey (tr)'],
	['ua', 'Ukraine (ua)'],        ['pl', 'Poland (pl)'],
	['vn', 'Vietnam (vn)'],        ['th', 'Thailand (th)'],
	['id', 'Indonesia (id)'],      ['ph', 'Philippines (ph)'],
	['ae', 'UAE (ae)'],            ['sa', 'Saudi Arabia (sa)']
];

// A routing rule's destination is an ordered list of conditions, each of one
// of these kinds. domain* / ip_cidr / protocol / port are native sing-box
// matchers; ruleset / country resolve to rule-set references.
var KINDS = [
	[ 'domain',         _('Domain (exact)') ],
	[ 'domain_suffix',  _('Domain suffix')  ],
	[ 'domain_keyword', _('Domain keyword') ],
	[ 'domain_regex',   _('Domain regex')   ],
	[ 'ip_cidr',        _('IP / CIDR')      ],
	[ 'ruleset',        _('Rule-set')       ],
	[ 'country',        _('Country')        ],
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
	country:        _('country'),
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
	country:        'cn',
	protocol:       'tls',
	port:           '80, 443, 8000-8100'
};

// Monotonic counter for unique <datalist> element ids.
var dlSeq = 0;

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
// fully custom `parse`. The suggestion sets (rsSuggest / countrySuggest /
// protoSuggest) are assigned per-instance in render(), once the rule-set
// catalog has loaded.
var ConditionList = form.DummyValue.extend({
	cfgvalue: function(section_id) {
		return readConditions(section_id);
	},

	renderWidget: function(section_id) {
		var rsSuggest      = this.rsSuggest      || null;
		var countrySuggest = this.countrySuggest || null;
		var protoSuggest   = this.protoSuggest   || null;

		var rowsEl  = E('div', {});
		var preview = E('div', {
			'style': 'margin-top:8px; font-style:italic; opacity:0.75'
		});

		function suggestionsFor(kind) {
			if (kind === 'ruleset')  return rsSuggest;
			if (kind === 'country')  return countrySuggest;
			if (kind === 'protocol') return protoSuggest;
			return null;
		}

		// Build a value editor for one condition kind. Returns { node, get }:
		// `node` is mounted in the row, `get()` returns the value array.
		//
		// `port` gets a single text input — comma-separated ports, `lo-hi`
		// for ranges (80, 443, 8000-8100) — which suits short tokens far
		// better than a growable list. Every other kind keeps a
		// free-typeable ui.DynamicList; a native <datalist> offers
		// suggestions for the kinds that have them without blocking
		// arbitrary values.
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
				var listId = 'prism-dl-' + (++dlSeq);
				var datalist = E('datalist', { 'id': listId });
				sugg.forEach(function(it) {
					datalist.appendChild(E('option', {
						'value': Array.isArray(it) ? it[0] : it
					}));
				});
				node.appendChild(datalist);
				var bind = function(inp) {
					if (inp && inp.tagName === 'INPUT' && inp.type === 'text')
						inp.setAttribute('list', listId);
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
			var sid = uci.add('prism', 'condition');
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
			callListRulesets().catch(function() { return {}; })
		]);
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

		function addOutbounds(o) {
			o.value('direct', _('direct (no proxy)'));
			o.value('block',  _('block (drop)'));
			outbounds.forEach(function(ob) {
				o.value(ob.tag, ob.tag);
			});
		}

		var m = new form.Map('prism');

		// ── default outbound ────────────────────────────────────────────
		var ds = m.section(form.NamedSection, 'routing', 'routing', _('Default outbound'),
			_('Outbound for traffic not matched by any rule below.'));
		ds.addremove = false;

		var oFinal = ds.option(form.ListValue, 'final_outbound', _('Default outbound'));
		addOutbounds(oFinal);

		// ── rules ───────────────────────────────────────────────────────
		var s = m.section(form.GridSection, 'rule', _('Rules'),
			_('Evaluated top-to-bottom; first match wins. Each rule matches a ' +
			  'destination built from one or more conditions joined with ' +
			  'AND / OR, and sends matching traffic to an outbound. Changes ' +
			  'are staged until Save; Save & Apply also reloads the service.'));
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add rule');
		s.modaltitle = function() { return _('Routing rule'); };

		// Create each rule as a NAMED section with a stable generated name.
		// An anonymous section gets a temporary `newNNNN` id that LuCI renames
		// to a real `cfgXXXX` id on save; a child condition's `rule`
		// back-reference, captured as that temp id, would not follow the
		// rename — orphaning every condition added in the same modal session
		// as the new rule. An explicit name is fixed from creation through
		// commit. `anonymous` still hides the name in the UI.
		var gridHandleAdd = s.handleAdd;
		s.handleAdd = function(ev) {
			var name = 'rule_' + Date.now().toString(36) + '_' +
			           Math.floor(Math.random() * 0xffffff).toString(16);
			return gridHandleAdd.call(this, ev, name);
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
		var oMatch = s.option(form.DummyValue, '_match', _('Destination'));
		oMatch.modalonly = false;
		oMatch.cfgvalue = function(section_id) {
			return ruleSummary(section_id);
		};

		var oOut = s.option(form.ListValue, 'outbound', _('Outbound'));
		addOutbounds(oOut);

		// ── Destination — the condition builder ──────────────────────────
		var oCond = s.option(ConditionList, '_conditions', _('Conditions'),
			_('Each condition matches one facet of the destination. Conditions ' +
			  'are joined by the AND / OR operator shown above each row; AND ' +
			  'binds tighter than OR, so a rule matches an OR of AND-groups ' +
			  '(see the preview below). Set a row to "is not" to invert it. ' +
			  'A rule with no conditions does nothing and is skipped — the ' +
			  'default outbound already handles otherwise-unmatched traffic.'));
		oCond.modalonly = true;
		oCond.rsSuggest      = rsTokens;
		oCond.countrySuggest = COUNTRIES;
		oCond.protoSuggest   = PROTOCOLS.slice().sort();

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
		return m.render();
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.resetGrid(this); }
});

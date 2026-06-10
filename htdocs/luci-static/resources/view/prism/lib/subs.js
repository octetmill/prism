// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Subscription display helpers shared by the Nodes / Routing / Status
// panels. Subscriptions are keyed by their UCI section name — which IS the
// subscription's uid (see docs/decisions.md "Section identity is the
// section name") and matches what list_outbounds emits in `subscription`.
// Two subscriptions can carry nodes with identical tags; the label shown
// in dropdowns must make clear which subscription a tag comes from, and
// listing order must match the Subscriptions section everywhere.

'use strict';
'require baseclass';
'require uci';

return baseclass.extend({
	// uid → display name (falls back to the uid when `name` is unset).
	nameMap: function() {
		var map = {};
		uci.sections('prism', 'subscription').forEach(function(sub) {
			var u = sub['.name'];
			map[u] = sub.name || u;
		});
		return map;
	},

	// uid → index in Subscriptions-section order.
	orderMap: function() {
		var map = {};
		uci.sections('prism', 'subscription').forEach(function(sub, idx) {
			map[sub['.name']] = idx;
		});
		return map;
	},

	// Sort group: 0 = manual node (no subscription), 1+ = subscriptions in
	// section order, Infinity = orphan (saved tag whose source is gone).
	groupKey: function(sub_id, orderMap) {
		if (!sub_id) return 0;
		if (sub_id in orderMap) return 1 + orderMap[sub_id];
		return Infinity;
	},

	// "<subscription>/<tag>" for a subscription node, bare tag for a manual
	// node or an orphan.
	labelFor: function(tag, sub_id, nameMap) {
		if (sub_id && nameMap[sub_id])
			return nameMap[sub_id] + '/' + tag;
		return tag;
	},

	// Comparator for { group, idx, label } entries: subscription-section
	// order first, original index within a source, label as tiebreak.
	entryCompare: function(a, b) {
		if (a.group !== b.group) return a.group - b.group;
		if (a.idx   !== b.idx)   return a.idx   - b.idx;
		return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
	}
});

// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 OctetMill

// Generate a 16-hex-char (64-bit) random identifier used as the section
// NAME for every anonymous UCI section type in /etc/config/prism. The
// section name itself is the stable id — there is no parallel `uid` UCI
// option to keep in sync, and libuci's volatile cfgXXXX is never minted
// for prism sections. See docs/decisions.md ("Section identity is the
// section name") for the rationale.

'use strict';
'require baseclass';

return baseclass.extend({
	generate: function() {
		var bytes = new Uint8Array(8);
		window.crypto.getRandomValues(bytes);
		var s = '';
		for (var i = 0; i < bytes.length; i++)
			s += ('0' + bytes[i].toString(16)).slice(-2);
		return s;
	},

	// Wrap a GridSection's handleAdd so the Add button mints a uid as the
	// new section's name before the modal opens. Every prism section type
	// uses uid section names (see above), so every grid panel needs this.
	installGridAdd: function(section) {
		var generate = this.generate;
		var gridHandleAdd = section.handleAdd;
		section.handleAdd = function(ev, name) {
			return gridHandleAdd.call(this, ev, name || generate());
		};
	}
});

# Remote rule-set URLs computed at build time, not stored in UCI

`routing.js` stores `rs_source`, `rs_delivery`, and `rs_name` for preset sources (sagernet, loyalsoldier, metacubex). `build-config` constructs the download URL via `build_ruleset_url()`. Only custom-source rule-sets store `rs_url` directly in UCI. This avoids stale URLs surviving source changes and keeps the UCI config human-readable.

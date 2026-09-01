# sing-box JSON is generated, not hand-edited

Prism's source of truth is UCI (`/etc/config/prism`) plus `/etc/prism/nodes/*.json`. `/usr/libexec/prism/build-config` assembles a complete sing-box JSON from those inputs and writes it to `prism.global.config_path`. The init script runs the generator before each (re)start; the `regenerate_config` RPC method runs it on demand from the UI. The Log & Configuration tab shows a read-only preview, with an editable `/etc/prism/extra.json` merge slot (shallow-merged into the top-level object) for advanced overrides.

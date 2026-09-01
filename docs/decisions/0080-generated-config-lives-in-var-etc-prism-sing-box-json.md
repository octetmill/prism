# Generated config lives in `/var/etc/prism/sing-box.json`, not `/etc/sing-box/`

`/var` is tmpfs on OpenWrt — no flash wear, no stale files surviving config edits, and aligns with how dnsmasq/odhcpd handle their derived configs. The `prism/` subdirectory namespaces the file so it can't collide with a user-managed `/etc/sing-box/config.json`. UCI `prism.global.config_path` defaults to the new location but is still overridable for power users.

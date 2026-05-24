# Prism

A point-and-click web UI for [sing-box](https://sing-box.sagernet.org/) on
OpenWrt. Manage proxy subscriptions, routing rules, rule-sets and DNS from
your router's admin page — no JSON editing required.

<!--
  TODO: drop a screenshot at docs/screenshot.png and uncomment:
  ![Prism dashboard](docs/screenshot.png)
-->

## What you get

A single **Services → Prism** page in LuCI, organised into four tabs:

| Tab | What it does |
|---|---|
| **Status**   | See whether sing-box is running, start / stop / restart it, view the live log, peek at the generated config. |
| **Nodes**    | Add proxy subscriptions that auto-refresh on a schedule; or paste in individual nodes by hand. Supports VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC, AnyTLS, WireGuard and SOCKS. |
| **Routing**  | Build routing rules with AND/OR conditions (domain match, IP/CIDR, rule-set, protocol, port), pick the outbound per rule, and configure rule-set sources. |
| **Settings** | Inbound mode, DNS upstreams, rule-set delivery, logging and a handful of advanced overrides. |

Everything is stored in standard UCI config (`/etc/config/prism`); the
sing-box JSON config is generated for you.

## Install

### Latest snapshot (rolling, recommended)

Rebuilt on every commit. The URL is stable — re-run this snippet later to
upgrade.

OpenWrt **25.12+** (APK):

```sh
ssh root@192.168.1.1 '
  wget -O /tmp/prism.apk https://github.com/octetmill/prism/releases/download/snapshot/luci-app-prism-snapshot.apk \
  && apk add --allow-untrusted /tmp/prism.apk \
  && service rpcd reload
'
```

OpenWrt **24.10** (opkg):

```sh
ssh root@192.168.1.1 '
  wget -O /tmp/prism.ipk https://github.com/octetmill/prism/releases/download/snapshot/luci-app-prism-snapshot.ipk \
  && opkg install /tmp/prism.ipk \
  && service rpcd reload
'
```

Then open `http://<router>/cgi-bin/luci/admin/services/prism` and head to
the **Nodes** tab to add your first subscription.

### Tagged release

Pick the latest `.apk` (25.12+) or `.ipk` (24.10) from the
[Releases](../../releases) page, copy it to the router, and install with
`apk add --allow-untrusted` or `opkg install`.

### Requirements

OpenWrt 24.10 or 25.12+ with `sing-box ≥ 1.12`. The package pulls in
everything else it needs (`luci-base`, `luci-lib-jsonc`, `rpcd`,
`rpcd-mod-rpcsys`, `uclient-fetch`, `ca-bundle`).

## Upgrade

Re-run the same install snippet — APK and opkg both replace in place. The
UCI config at `/etc/config/prism` is marked as a conffile, so your
settings survive upgrades.

## Uninstall

```sh
apk del luci-app-prism            # OpenWrt 25.12+
opkg remove luci-app-prism        # OpenWrt 24.10
```

This stops the service and removes the package. Your `/etc/config/prism`
is preserved unless you also run `rm /etc/config/prism`.

## Troubleshooting

**Where are the logs?**
The Status tab has *View full log*. From a shell:

```sh
logread -e prism
logread -e sing-box
```

**What's actually being sent to sing-box?**
Status tab → *View generated config*, or:

```sh
cat /var/etc/prism/sing-box.json
```

**Service won't start.**
Prism runs `sing-box check` before starting and refuses to swap in a
broken config — the existing config keeps running. Look at the Prism log
for the rejection reason, fix it in the UI, save & apply.

**Stop the proxy without uninstalling.**
Status tab → *Stop*, and toggle *Autostart* off if you don't want it to
come back on reboot.

**Reset to defaults.**
```sh
rm /etc/config/prism
apk add --force-overwrite --allow-untrusted /tmp/prism.apk
```
(replace `apk` with `opkg install --force-reinstall` on 24.10). The
shipped uci-defaults will re-seed the config.

## Contributing

Build instructions, CI layout, and developer conventions live in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Design rationale for non-obvious
decisions is in [`docs/decisions.md`](docs/decisions.md).

## License

GPL-3.0-only

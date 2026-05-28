# Prism

A LuCI web UI for [sing-box](https://sing-box.sagernet.org/) on OpenWrt.
Manage subscriptions, routing, rule-sets, and DNS from the router admin
page — no JSON to hand-edit.

<!--
  TODO: drop a screenshot at docs/screenshot.png and uncomment:
  ![Prism dashboard](docs/screenshot.png)
-->

## Features

- **One LuCI page** at *Services → Prism*. A Basic/Advanced toggle in
  the tab bar swaps between a tight surface (Status + Basic) and the
  full one (Status, Nodes, Routing, Settings). Switching is
  non-destructive — your Advanced config stays on disk.
- **Subscriptions and manual nodes.** Fetch and refresh remote node
  lists; hand-add nodes for VLESS, VMess, Trojan, Shadowsocks,
  Hysteria2, TUIC, AnyTLS, WireGuard, and SOCKS.
- **Selectors and urltest groups.** Pick servers manually or let Prism
  pick the fastest; per-node latency testing is built in.
- **Routing rules with AND/OR conditions** — domain match, IP/CIDR,
  rule-set, protocol, port. Each rule has its own outbound.
- **Rule-set management.** Local sources, scheduled refresh, generated
  config plumbing.
- **DNS** with multiple upstreams, fake-IP, and per-rule resolution.
- **Transparent capture** in TProxy or TUN mode, on the router itself.
- **Safe applies.** `sing-box check` runs before every restart; a
  broken save keeps the running config alive.
- **UCI-backed.** All settings live in `/etc/config/prism`; the
  sing-box JSON is generated on save.

## Install

SSH into the router, then paste one of the commands below.

### Tagged release (recommended)

The [latest release](../../releases/latest) page has a copy-paste
one-liner with the version baked in — open it, copy the install
command from the notes, paste it on the router. The shape is:

```sh
wget -O /tmp/prism.apk <release-asset-url> && apk add --allow-untrusted /tmp/prism.apk && service rpcd reload
```

(`.ipk` + `opkg install` on 24.10.)

Then open `http://<router>/cgi-bin/luci/admin/services/prism` and add
your first subscription from the **Basic** tab (or **Nodes** in
Advanced mode).

### Snapshot (bleeding edge)

> **Warning.** Snapshots are rebuilt on every commit to `main`. They
> are not stability-tested, may include half-finished features, and
> can change UCI shape or behaviour without notice. Use them to track
> upcoming changes or to verify a fix; prefer a tagged release for
> anything you depend on.

The snapshot URL is stable — the same one-liner installs and upgrades.

**OpenWrt 25.12+** (APK):

```sh
wget -O /tmp/prism.apk https://github.com/octetmill/prism/releases/download/snapshot/luci-app-prism-snapshot.apk && apk add --allow-untrusted /tmp/prism.apk && service rpcd reload
```

**OpenWrt 24.10** (opkg):

```sh
wget -O /tmp/prism.ipk https://github.com/octetmill/prism/releases/download/snapshot/luci-app-prism-snapshot.ipk && opkg install /tmp/prism.ipk && service rpcd reload
```

## Requirements

- OpenWrt **24.10** or **25.12+**.
- **sing-box ≥ 1.12** (pulled in as a dependency).
- **nftables.** Prism installs its own `inet prism` table via `nft`;
  iptables / fw3 are not supported. Both 24.10 and 25.12 ship
  fw4/nftables by default, so a stock install already qualifies.

Everything else (`luci-base`, `luci-lib-jsonc`, `rpcd`,
`rpcd-mod-rpcsys`, `uclient-fetch`, `ca-bundle`) is pulled in
automatically.

## Upgrade and uninstall

Re-running the install one-liner replaces the package in place.
`/etc/config/prism` is marked as a conffile, so your settings survive
upgrades.

To remove:

```sh
apk del luci-app-prism            # OpenWrt 25.12+
opkg remove luci-app-prism        # OpenWrt 24.10
```

The service stops and the package is removed; `/etc/config/prism` is
preserved unless you also `rm` it.

## Troubleshooting

**Logs.** Status tab → *View full log*, or from a shell:

```sh
logread -e prism
logread -e sing-box
```

**Generated sing-box config.** Status tab → *View generated config*,
or:

```sh
cat /var/etc/prism/sing-box.json
```

**Service won't start.** Prism runs `sing-box check` before every
restart and refuses to swap in a broken config — the previous one keeps
running. The rejection reason shows up in the Prism log.

**Stop without uninstalling.** Status tab → *Stop*, and toggle
*Autostart* off to keep it from coming back on reboot.

**Reset to defaults.**

```sh
rm /etc/config/prism
apk add --force-overwrite --allow-untrusted /tmp/prism.apk
# 24.10:
# opkg install --force-reinstall /tmp/prism.ipk
```

The shipped uci-defaults re-seed the config.

## Contributing

Build instructions, CI layout, and developer conventions live in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Design rationale for non-obvious
decisions is in [`docs/decisions.md`](docs/decisions.md).

## License

GPL-3.0-only — see [`LICENSE`](LICENSE) for the full text.

The packaged `.apk` / `.ipk` runs a comment-stripping pass over the
source on its way into the install tree, so the on-router copy is
about half the size of the repo source. The `SPDX-License-Identifier`
and `Copyright` headers are preserved on every installed file, and the
package's `license:` metadata field records `GPL-3.0-only`. The repo
source is the canonical, fully-commented form — clone the repo to read
the code with its design notes intact.

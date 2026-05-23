# Prism

LuCI web interface for [sing-box](https://sing-box.sagernet.org/) on OpenWrt.

Prism adds a single **Services → Prism** page to the LuCI UI, organised
into tabs:

| Tab | Purpose |
|---|---|
| Overview | Service status and start / stop / restart controls |
| Subscriptions | Proxy-subscription URLs with periodic auto-update |
| Nodes | Manually-configured proxy nodes |
| Routing | Destination-based routing rules |
| Settings | Service, inbound, DNS, rule-set and advanced options |
| Diagnostics | Live log tail and a generated-config preview |

## Requirements

- OpenWrt **25.12+** (APK) or **≤24.10** (IPK/opkg)
- Runtime dependencies (installed automatically): `luci-base`, `luci-lib-jsonc`, `sing-box (>=1.12)`, `rpcd`, `rpcd-mod-rpcsys`, `uclient-fetch`, `ca-bundle`

## Installing

### Latest snapshot (rolling, recommended for testing)

Stable URL — rebuilt on every commit, always the tip of active development.
`apk` doesn't accept remote URLs directly, so download first:

```sh
ssh root@192.168.1.1 '
  wget -O /tmp/prism.apk https://github.com/octetmill/prism/releases/download/snapshot/luci-app-prism-snapshot.apk \
  && apk add --allow-untrusted /tmp/prism.apk \
  && service rpcd reload
'
```

For OpenWrt ≤24.10 (opkg):

```sh
ssh root@192.168.1.1 '
  wget -O /tmp/prism.ipk https://github.com/octetmill/prism/releases/download/snapshot/luci-app-prism-snapshot.ipk \
  && opkg install /tmp/prism.ipk \
  && service rpcd reload
'
```

### Tagged release

Download the latest `.apk` (OpenWrt 25.12+) or `.ipk` (OpenWrt ≤24.10) from the
[Releases](../../releases) page, copy it to the router, and install with
`apk add --allow-untrusted` or `opkg install`.

## Building from source

Requires apk-tools 3.x (`apk mkpkg`), `fakeroot`, `tar`, `gzip`, `ar`, `find`, `wc`.
On distributions without apk-tools 3.x packaged, build it from source — see
`.github/workflows/snapshot.yml` for the exact invocation used by CI.

```sh
sh .github/workflows/package.sh
# → dist/luci-app-prism-<version>-r<release>.apk
# → dist/luci-app-prism_<version>-<release>_all.ipk
```

Version derivation:

| Situation | Example version |
|---|---|
| Snapshot build (any branch, no `v*` tag at HEAD) | `0.1.0_pre7-r1` |
| Tag build (CI from `v0.1.0`)                     | `0.1.0-r1`      |
| Tag build (CI from `v0.1.0-r2`)                  | `0.1.0-r2`      |

`PKG_VERSION` in the `Makefile` is the **next** release being worked toward.
Snapshots are `<PKG_VERSION>_pre<N>` where N = commits since the last `v*` tag.

### Using the OpenWrt SDK

```sh
cp -r /path/to/prism <sdk>/package/luci-app-prism
make package/luci-app-prism/compile V=s
```

Output: `bin/packages/<arch>/base/luci-app-prism_*.apk`

## CI

| Workflow | Trigger | Output |
|---|---|---|
| **Snapshot** | Push to any non-`main` branch | Asset replaced on rolling `snapshot` pre-release (stable URL); also archived as a workflow artifact for 30 days |
| **Release**  | Push of a `v*` tag             | New immutable GitHub release at that tag, with APK and IPK assets |

## Repository layout

```
.github/
├── actions/install-apk-tools/   # CI: build apk-tools 3.x
└── workflows/
    ├── package.sh               # Standalone APK + IPK builder
    ├── snapshot.yml             # CI: snapshot on every branch push
    └── release.yml              # CI: release on v* tag push
Makefile                         # OpenWrt SDK build descriptor (luci.mk)
htdocs/luci-static/resources/view/prism/
├── main.js                      # Host view — the tab shell
├── overview.js  subscriptions.js  nodes.js  routing.js  diagnostics.js
├── service.js  inbound.js  dns.js  rulesets.js  advanced.js
└── lib/                         # Shared view helpers (formpanel, ordersave)
root/
├── etc/
│   ├── config/prism             # Default UCI config (conffile)
│   ├── init.d/prism             # procd init script
│   └── uci-defaults/            # One-time config migrations
└── usr/
    ├── libexec/prism/           # build-config, firewall.sh, fetch-rulesets,
    │                            #   sync-subscriptions, watchdog, hourly, prismlib.lua
    ├── libexec/rpcd/luci.prism  # rpcd handler
    └── share/
        ├── luci/menu.d/luci-app-prism.json
        └── rpcd/acl.d/luci-app-prism.json
po/templates/luci-app-prism.pot  # Gettext translation template
```

## License

GPL-3.0-only

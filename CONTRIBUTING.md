# Contributing to Prism

Thanks for poking at the code. This file covers building and the
repository layout. For the project's conventions and design rationale,
read [`CLAUDE.md`](CLAUDE.md) (style, package structure, LuCI/rpcd
patterns) and [`docs/decisions.md`](docs/decisions.md) (the running log
of non-obvious choices — check it before reversing one).

## Building from source

### Standalone (no OpenWrt SDK)

Requires `apk` (apk-tools 3.x with `mkpkg`), `fakeroot`, `tar`, `gzip`,
`ar`, `find`, `wc`. Distributions without apk-tools 3.x packaged need to
build it from source — see `.github/workflows/snapshot.yml` for the
exact invocation CI uses.

```sh
sh .github/workflows/package.sh
# → dist/luci-app-prism-<version>-r<release>.apk
# → dist/luci-app-prism_<version>-<release>_all.ipk
```

The `Makefile` is the single source of truth for package metadata
(`PKG_VERSION`, `LUCI_DEPENDS`, conffiles, …). `package.sh` parses those
values out — never edit them in `package.sh`.

### Using the OpenWrt SDK

```sh
cp -r /path/to/prism <sdk>/package/luci-app-prism
make package/luci-app-prism/compile V=s
```

Output: `bin/packages/<arch>/base/luci-app-prism_*.apk`

### Installing your build on a router

```sh
scp dist/luci-app-prism_*.apk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'apk add --allow-untrusted /tmp/luci-app-prism_*.apk && service rpcd restart'
```

## Versioning

The git tag is the single source of truth for releases. Snapshots are
derived from the most recent `v*` tag plus a commit-since-tag count, so
the snapshot version is always honest about which release it follows.

| Situation                                       | Example version |
|---|---|
| Snapshot, N commits past `v0.1.0`               | `0.1.0_git7-r1` |
| Snapshot, no `v*` tag yet (bootstrap)           | `0.1.0_pre7-r1` |
| Tag build (CI from `v0.1.0`)                    | `0.1.0-r1`      |
| Tag build (CI from `v0.1.0-r2`)                 | `0.1.0-r2`      |

APK suffix order puts `<tag>` < `<tag>_git<N>` < `<next-tag>`, so
`apk upgrade` picks newer snapshots and never downgrades past the tag.
`_git` is Alpine's conventional suffix for VCS snapshots taken after a
release.

`PKG_VERSION` in the `Makefile` is **not** consulted by the standalone
builder once any `v*` tag exists — it's only used by the OpenWrt SDK
build path. Keep it set to a sensible value (typically the next planned
release).

## Releasing

Releases are an explicit, deliberate act — pushing a `v*` tag is the
release decision. Merges to `main` do not trigger releases.

```sh
# After merging the changes that constitute the release to main:
git checkout main && git pull
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

No Makefile edit is required. Snapshots from the next commit on will be
`0.2.0_git<N>-r1` automatically.

## CI

| Workflow | Trigger | Output |
|---|---|---|
| **Snapshot** | Push to any non-`main` branch | Asset replaced on the rolling `snapshot` pre-release (stable URL); archived as a workflow artifact for 30 days. |
| **Release**  | Push of a `v*` tag             | New immutable GitHub release at that tag, with APK and IPK assets. |

Both workflows live in `.github/workflows/` alongside `package.sh`.

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
├── status.js  nodes.js  routing.js  settings.js   # One panel per tab
└── lib/                         # Shared view helpers (formpanel, ordersave)
root/
├── etc/
│   ├── config/prism             # Default UCI config (conffile)
│   ├── init.d/prism             # procd init script
│   └── prism/extra.json         # Advanced overrides (conffile)
└── usr/
    ├── libexec/prism/           # build-config, firewall.sh, fetch-catalog,
    │                            #   sync-subscriptions, watchdog, hourly, prismlib.lua
    ├── libexec/rpcd/luci.prism  # rpcd handler
    └── share/
        ├── luci/menu.d/luci-app-prism.json
        └── rpcd/acl.d/luci-app-prism.json
po/templates/luci-app-prism.pot  # Gettext translation template
```

## Branch naming

Short, descriptive kebab-case topic branches: `view-subscription-nodes`,
`fix-dnsmasq-confdir`, `migrate-wireguard-endpoint`. Avoid auto-generated
session-style names like `claude/foo-bar-1234`.

## Translations

Translatable strings in JS views use `_(…)`. The `.pot` template is
extracted at build time and lives at `po/templates/luci-app-prism.pot`.
Add `.po` files under `po/<lang>/luci-app-prism.po`.

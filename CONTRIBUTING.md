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

`PKG_VERSION` in the `Makefile` is the **next** release being worked
toward, not the last one shipped. Bump it immediately after tagging a
release.

| Situation | Example version |
|---|---|
| Snapshot build (any branch, no `v*` tag at HEAD) | `0.1.0_pre7-r1` |
| Tag build (CI from `v0.1.0`)                     | `0.1.0-r1`      |
| Tag build (CI from `v0.1.0-r2`)                  | `0.1.0-r2`      |

Snapshots are `<PKG_VERSION>_pre<N>` where N = commits since the last
`v*` tag. `PKG_RELEASE` resets to `1` when `PKG_VERSION` changes;
increment it for packaging-only fixes (release as a `v<VERSION>-r<N>`
tag).

## Releasing

Releases are an explicit, deliberate act — pushing a `v*` tag is the
release decision. Merges to `main` do not trigger releases.

```sh
# 1. After merging the changes that constitute the release to main:
git checkout main && git pull
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0

# 2. Bump PKG_VERSION in the Makefile to the next planned version
#    and commit. Snapshots from then on will be <next>_pre<N>-r1.
```

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
│   └── uci-defaults/            # One-time config migrations
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

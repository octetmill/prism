# Contributing to Prism

Thanks for poking at the code. This file covers building and the
repository layout. The project's own conventions, style guide, and design
rationale live in a private companion document set, not in this repo —
ask a maintainer if you need access.

## Building from source

### Standalone (no OpenWrt SDK)

Requires `apk` (apk-tools 3.x with `mkpkg`), `fakeroot`, `tar`, `gzip`,
`ar`, `find`, `wc`. Distributions without apk-tools 3.x packaged need to
build it from source — see `.github/workflows/snapshot.yml` for the
exact invocation CI uses.

```sh
sh .github/workflows/package.sh
# → dist/luci-app-prism-<version>-r<release>.apk
# → dist/luci-app-prism_<version>-r<release>_all.ipk
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
ssh root@192.168.1.1 'apk add --allow-untrusted /tmp/luci-app-prism_*.apk && service rpcd reload'
```

## Versioning

Full rules, including the apk and opkg format constraints, live in
[`docs/versioning.md`](docs/versioning.md). Read that before changing
anything in the packaging pipeline. The shapes:

| Situation                                       | Example version              |
|---|---|
| Release (CI from tag `v0.1.0`)                  | `0.1.0-r1`                   |
| Packaging re-release (CI from tag `v0.1.0-r2`)  | `0.1.0-r2`                   |
| Snapshot past `v0.1.0`                          | `0.1.0_git20260913085134-r1` |
| Snapshot, no `v*` tag yet (bootstrap)           | `0.1.0_pre20260913085134-r1` |

Three rules carry most of it:

- `PKG_VERSION` / `PKG_RELEASE` in the `Makefile` are authoritative and
  **trail** the timeline — they name the version most recently released.
  The `v*` tag is the release decision, and `release.yml` fails the
  release if the two disagree rather than overriding the Makefile.
- The snapshot suffix is HEAD's **commit timestamp**, never a commit
  count. A count collides across branches and moves backwards when a
  branch is rebased.
- `-r<N>` is the **packaging revision** and nothing else, for both
  package formats. It is never a build counter.

`version-check.sh` asserts these against apk's own parser and runs in
both workflows. With an `apk` on PATH it also runs locally:

```sh
sh .github/workflows/version-check.sh
```

## Releasing

Releases are an explicit, deliberate act — pushing a `v*` tag is the
release decision. Merges to `main` do not trigger releases.

```sh
# After merging the changes that constitute the release to main:
git checkout main && git pull
$EDITOR Makefile            # PKG_VERSION:=0.2.0
git commit -am "Release 0.2.0"
git push

git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

Record the version being released in the Makefile first — the tag must
match it, or `release.yml` fails the release rather than guessing which
of the two is right. `PKG_RELEASE` resets to `1` whenever `PKG_VERSION`
changes; bump only `PKG_RELEASE` for a packaging-only re-release of the
same source, and tag that `v0.2.0-r2`.

Snapshots from the next commit on are `0.2.0_git<timestamp>-r1`
automatically.

## CI

| Workflow | Trigger | Output |
|---|---|---|
| **Snapshot** | Push to any non-`main` branch | Asset replaced on the rolling `snapshot` pre-release (stable URL); the exact build also archived as a workflow artifact for 30 days, which is what `push-to-router.sh` installs from. |
| **Release**  | Push of a `v*` tag             | New immutable GitHub release at that tag, with APK and IPK assets. |
| **Feed**     | After a successful Release run | Rebuilds the signed GitHub Pages feed from every `v*` release. |

All three workflows live in `.github/workflows/` alongside the scripts
they call.

## Repository layout

```
.github/
├── actions/install-apk-tools/   # CI: build apk-tools 3.x
├── actions/install-usign/       # CI: build OpenWrt's usign
└── workflows/
    ├── package.sh               # Standalone APK + IPK builder
    ├── version-check.sh         # Version scheme asserted against apk's parser
    ├── feed.sh                  # Signed apk + opkg feed assembly
    ├── release-notes.sh         # Shared release/snapshot notes body
    ├── snapshot.yml             # CI: snapshot on every branch push
    ├── release.yml              # CI: release on v* tag push
    └── pages.yml                # CI: publish the feed to GitHub Pages
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

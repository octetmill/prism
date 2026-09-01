# Packaging facts (APK 3.x format constraints)

Discovered iteratively while bringing up the standalone builder; current rules now live under Makefile § "Version format" in `CLAUDE.md`. Briefly: `~` is rejected by APK — use `_pre<N>` for snapshots; `arch: all` is rejected — use `noarch`, translated from `LUCI_PKGARCH=all`; hand-assembled gzip streams fail on OpenWrt 25.12, only `apk mkpkg` (apk-tools 3.x) produces a valid APK; `/lib/apk/packages/<pkg>.{list,conffiles}` metadata files must be staged under the package root before `apk mkpkg` runs.

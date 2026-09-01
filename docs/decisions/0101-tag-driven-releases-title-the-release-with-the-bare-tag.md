# Tag-driven releases title the GitHub release with the bare tag, matching the UI-created ones

`release.yml` has two publish paths, and until v0.8.2 only one of them had
ever run. When the release already exists — created from the GitHub UI,
which mints the tag and the release together — the workflow just uploads
the built packages and deliberately leaves the UI-authored title and notes
alone. When only the tag exists, which is what the documented procedure in
`CLAUDE.md` produces (`git tag -a v0.8.2` + `git push origin v0.8.2`), the
workflow creates the release itself. That second path had carried
`--title "luci-app-prism $TAG"` since the initial commit, so v0.8.2 — the
first release actually made by pushing a tag — landed in the release list
as `luci-app-prism v0.8.2` among a decade of plain `v0.8.1`, `v0.8.0`, …
entries hand-made in the UI. Nothing was wrong with the package; the two
paths simply disagreed about naming and only now met. The workflow now
titles it `$TAG`, so the documented tag-push procedure produces a release
indistinguishable from the earlier hand-made ones, and v0.8.2 was renamed
in place to match. The bare tag wins over the prefixed form because the
repository already has a decade of releases named that way and the
repository name is redundant on its own releases page.

# Prism — Decisions & Context

Running log of design decisions and solved problems, so future work has
the rationale available.

This is the long-form record; for actionable rules and conventions, see
`CLAUDE.md`. Before reversing a design choice or revisiting a settled
question, check here first — `grep -rl '<keyword>' docs/decisions/` finds
the relevant entries, and each one is small enough to read whole.

## Adding an entry

One decision per file, named `NNNN-slug.md`, where `NNNN` is the next
free number (entries are numbered in the order they were written) and the
slug is a kebab-case shortening of the title:

```markdown
# <the decision, stated as what was done>

<why — the problem it solves, what was measured or observed, what was
rejected and on what grounds.>
```

Never collect entries into a shared file or index. This log used to be a
single Markdown table, `docs/decisions.md`, with every new entry appended
as the last row. Two branches in flight then both added a line at the same
anchor, which git cannot merge — it conflicted on essentially every
parallel branch, twice in one afternoon before the split. A new file per
entry cannot collide, so the conflicts are gone by construction. A
generated index would bring them straight back: the filenames are the
index.

(`.gitattributes` with `merge=union` was the obvious cheaper fix and does
work locally, but GitHub ignores user-defined merge drivers when it
computes a pull request's mergeability, so the PR would still have been
flagged as conflicting — see <https://github.com/orgs/community/discussions/9288>.)

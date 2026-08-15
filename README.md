# notion-sync-workflow

Syncs GitHub pull requests into a Notion database, and derives ticket status
from the state of each ticket's linked PRs. A ticket becomes `Completed` once
every PR linked to it is merged.

Replaces Notion's native GitHub integration, which is Business-tier only.
See [DESIGN.md](DESIGN.md) for why, and for the reasoning behind each decision.

## How it works

```
repo A ─┐
repo B ─┼─► caller workflow ──► sync.yml ──► this action ──┬─► PR database
repo C ─┘                                                  └─► Tickets database
```

A PR event fires in a source repo, the action upserts that PR's Notion page,
then recomputes every ticket the PR is — or was — linked to. A separate
reconcile run repairs drift that events alone cannot catch.

## Linking a PR to a ticket

Any of these, checked in order:

1. `Ticket: UX-12` in the PR body (also `Closes UX-12`, or a pasted Notion URL)
2. a branch named `feat/UX-12/thing` or `ux-12-thing`
3. a title starting `[UX-12]` or `UX-12:`

PRs with no resolvable reference land in the `unlinked` triage view. They never
fail the workflow.

## Setup

1. Build the two Notion databases — see [docs/notion-setup.md](docs/notion-setup.md).
2. Connect both to a Notion integration.
3. On **each** source repo, add repo secrets `NOTION_TOKEN`,
   `NOTION_TICKETS_DB`, `NOTION_PR_DB`. (`ubcuxhub` is a personal account, so
   there is no org secret scope — see DESIGN.md §8.2.)
4. Add each repo to `sync.config.json`, and copy
   [docs/caller-workflow.yml](docs/caller-workflow.yml) into it.
5. Tag this repo `v1` — callers reference the tag, not `main`.

## Local use

```bash
cp .env.example .env   # fill in the token and both database ids
npm install
npm run verify-schema  # checks Notion matches what the code expects
```

Sync one PR, without writing anything:

```bash
DRY_RUN=1 npm run sync -- --repo acme/ux-hub-web --pr 42
```

Repair drift across every configured repo:

```bash
npm run sync -- --reconcile --since-days 30
```

Note: if `.env` sets `GITHUB_TOKEN`, the `gh` CLI will use *that* token too, so
`gh auth token` returns it rather than the one in your keyring.

## Development

```bash
npm test          # unit tests for the four core rules
npm run typecheck
npm run build     # bundles dist/ — must be committed, the Action runs it
```

`dist/` is the compiled bundle GitHub actually executes. Rebuild and commit it
with any change to `src/`, or the Action keeps running the old code while the
source looks correct.

## Releasing

Source repos reference `notion-sync-workflow@v1`, never `main`, so **pushing to
`main` changes nothing for them** — the `v1` tag has to move.

```bash
npm run release
```

That typechecks, tests, rebuilds, refuses to continue if `dist/` no longer
matches `src/`, then pushes `main` and force-moves `v1`. A floating major tag is
the same convention `actions/checkout@v4` uses.

What needs a release, and what doesn't:

| Changed | Release? |
|---|---|
| `src/**` (and so `dist/`) | **yes** |
| `action.yml` | **yes** |
| `.github/workflows/sync.yml` — the reusable workflow | **yes** |
| `.github/workflows/reconcile.yml` | no — runs from `main` |
| `DESIGN.md`, `README.md`, `docs/`, `test/` | no |

`reconcile.yml` is the confusing one: the workflow file is read from `main`, but
the action it invokes is pinned to `@v1`, so a `src/` fix reaches reconcile only
after a release.

## Layout

| Path | |
|---|---|
| `src/core/` | the rules: state derivation, ticket refs, ticket status, markdown |
| `src/notion/` | client (API version 2025-09-03, data sources), upsert, tickets, body |
| `src/github/` | event payload and REST normalization, review decision |
| `src/modes/` | event and reconcile paths over a shared `syncPr` |
| `scripts/verify-schema.ts` | schema guard, run before every sync |

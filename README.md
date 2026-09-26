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
reconcile run repairs drift that events alone cannot catch, and a 15-minute poll
pushes edits made in Notion back to GitHub (see [Editing in Notion](#editing-in-notion)).

## Linking a PR to a ticket

Any of these, checked in order:

1. `Ticket: UX-12` in the PR body, or a pasted Notion page URL
2. a branch named `feat/UX-12/thing` or `ux-12-thing`
3. a title starting `[UX-12]` or `UX-12:`

Nothing is case sensitive — `ticket: ux-12` works as well as `Ticket: UX-12`.

In the body, the key needs one of these keywords in front of it, separated by a
space, a colon, or both:

```
ticket  tickets
close   closes   closed
fix     fixes    fixed
resolve resolves resolved
```

A bare `UX-12` in prose does **not** link — that's usually a cross-reference
("follow-up to UX-12"), not a claim to be doing the work. The keyword is what
separates mentioning a ticket from serving one. Branch and title matches need no
keyword.

One PR can serve several tickets: `Ticket: UX-1, UX-2`, or repeated lines.

PRs with no resolvable reference land in the `unlinked` triage view. They never
fail the workflow.

## Editing in Notion

`Ticket` and `Reviewers` on a PR row can be edited in Notion. Every 15 minutes a
scheduled run writes the edit to GitHub, and the row is then re-synced from
GitHub. Expect up to ~15 minutes' lag, more when GitHub runs cron late.

- **Ticket** is written into a marked block at the end of the PR description:

  ```
  <!-- notion-sync:tickets -->
  Ticket: UX-3, UX-7
  <!-- /notion-sync:tickets -->
  ```

  Unlinking every ticket leaves `Ticket: none`, which stops a key in the branch
  name or title from relinking it. A ticket named in your own words elsewhere in
  the description can't be unlinked from Notion — remove that line on GitHub.
- **Reviewers** are requested (or un-requested) on the PR. GitHub removes a
  reviewer from the list once they submit a review, so `Reviewers` means "still
  to review". Edits on closed or merged PRs are ignored.
- If GitHub rejects an edit — usually a login that isn't a collaborator — the
  field reverts and the reason appears in `Sync error`.

Rows that existed before write-back was deployed need one sync before edits
flow; an edit made before that is overwritten once.

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

Push pending Notion edits to GitHub:

```bash
DRY_RUN=1 npm run sync -- --poll
```

Repair drift across every configured repo:

```bash
npm run sync -- --reconcile --since-days 30
```

Note: if `.env` sets `GITHUB_TOKEN`, the `gh` CLI will use *that* token too, so
`gh auth token` returns it rather than the one in your keyring.

## Development

```bash
npm test          # unit tests for the core rules
npm run typecheck
npm run build     # bundles dist/ — must be committed, the Action runs it
```

`dist/` is the compiled bundle GitHub actually executes. Rebuild and commit it
with any change to `src/`, or the Action keeps running the old code while the
source looks correct.

## Releasing

```bash
git add -A && git commit -m "what you changed"
npm run release
```

**Use `npm run release`, not `git push`.** Source repos run
`notion-sync-workflow@v1`, so they follow the `v1` tag, not `main`. Pushing
without moving the tag ships nothing — and says nothing; the old code just keeps
running.

`release` typechecks, tests, rebuilds `dist/` (committing it if stale), pushes
`main`, and moves `v1`. It stops at the first failure, so a broken test can't
reach `uxhub`. Running it when nothing needed shipping is harmless.

## Layout

| Path | |
|---|---|
| `src/core/` | the rules: state derivation, ticket refs, ticket status, markdown, write-back merge, description region |
| `src/notion/` | client (API version 2025-09-03, data sources), upsert, tickets, body |
| `src/github/` | event payload and REST normalization, review decision, write-back (`write.ts`) |
| `src/modes/` | event, poll and reconcile paths over a shared `syncPr` |
| `scripts/verify-schema.ts` | schema guard, run before every sync |

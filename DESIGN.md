# notion-sync-workflow — design

Syncs GitHub pull requests into two Notion databases, and derives ticket status
from the state of each ticket's linked PRs.

Status: implemented; not yet rolled out to any repo.
Last updated: 2026-08-14

---

## 1. Background

Notion has native GitHub integration — a "connected property" on a database that
auto-updates from a linked PR, plus synced databases. Both are **Business-tier
features**. On Plus, the connected property silently reverts on save, on every
database including a clean one, and Google Drive is the only connector
available. Neither education offer lifts this; both cap at Plus.

The public Notion API and GitHub webhooks are available on every tier. So this
tool replaces the native integration with a GitHub Action that writes to Notion
directly.

## 2. Goals

- One Notion page per PR, kept in step with GitHub (state, timing, description).
- A ticket kanban whose status is derived from its linked PRs:
  a ticket becomes `Completed` when all of its PRs are merged.
- Works across **several separate repos** in one org, all feeding the same two
  databases.
- Self-healing: drift gets corrected without anyone noticing it first.

### Non-goals

- General Notion → GitHub sync. Only `Ticket` and `Reviewers` flow back
  (§16); every other property is one-directional.
- Real-time latency guarantees. Seconds-to-minutes is fine.
- Replacing GitHub as the source of truth for PRs.

## 3. Architecture

```
repo A ─┐
repo B ─┼─► caller workflow  ──► reusable workflow (this repo) ──► sync binary
repo C ─┘   (~15 lines each)                                          │
                                                            ┌─────────┴─────────┐
                                                            ▼                   ▼
                                                       PR database      Tickets database
                                                            └──── relation ─────┘
```

Two paths write to Notion:

1. **Event path.** A `pull_request` (or `pull_request_review`) event fires in a
   source repo → upsert that PR's page → recompute every ticket the PR is, or
   was, linked to.
2. **Reconcile path.** A run in this repo sweeps all configured repos and
   repairs drift. Same code as backfill, different `--since`.
3. **Poll path.** Every 10 minutes, a run in this repo finds PR rows where a
   human edited `Ticket` or `Reviewers`, writes that edit to GitHub, then syncs
   the row from GitHub as usual (§16).

The reconcile path is not optional maintenance work — see §10 for why event-only
sync always drifts.

## 4. Notion schema

### 4.1 PR database

One page per PR. `URL` is the identity; the upsert filters on it.

| Property | Type | Source |
|---|---|---|
| `Name` | title | `#123 · <PR title>` |
| `URL` | url | `pull_request.html_url` — **unique key** |
| `State` | select | derived, §4.3 |
| `Repo` | select | `owner/repo` |
| `Number` | number | `pull_request.number` |
| `Author` | select | `user.login` |
| `Reviewers` | multi-select | `requested_reviewers[].login`; editable, §16 |
| `Opened` | date | `created_at` |
| `Merged` | date | `merged_at` |
| `Closed` | date | `closed_at` |
| `Last activity` | date | `updated_at` |
| `Ticket` | relation → Tickets | resolved per §5; editable, §16 |
| `Link status` | select | `linked` / `unlinked` |
| `Body hash` | rich text | hidden; gates body rewrites (§6) |
| `Synced at` | date | hidden; staleness detection for reconcile |
| `Ticket shadow` | rich text | hidden; GitHub's ticket set at last sync (§16) |
| `Reviewers shadow` | rich text | hidden; GitHub's reviewers at last sync (§16) |
| `Sync error` | rich text | why the last push to GitHub failed (§16) |

The PR description is **not** a property. It lives in the page body (§6).

Deliberately excluded: `Assignees`, `Labels`, `Area`, `Draft` (redundant with
`State`), `Description` (now the body), `Key` (URL is already unique).

### 4.2 Tickets database

Kanban, grouped by `Status`.

| Property | Type | Notes |
|---|---|---|
| `Name` | title | |
| `ID` | **ID** (unique id), prefix `UX` | Notion mints `UX-1`, `UX-2`… |
| `Status` | status | `Draft` / `Assigned` / `Completed` |
| `PRs` | relation → PR DB | the other half of `Ticket` |
| `Status locked` | checkbox | sync skips this ticket entirely |
| `Auto-updated at` | date | last time sync wrote `Status` |

**The `ID` property type is read-only over the API** — Notion generates the
value. That's exactly what's wanted here: ticket keys are minted automatically,
are guaranteed unique, and are filterable via the `unique_id` filter, so
`Ticket: UX-123` in a PR body resolves in a single query. It's also why `ID` is
wrong for the PR database — you can't write `owner/repo#123` into one.

### 4.3 `State` derivation

`State` is a `select`, not a `status`. **The Notion API cannot create new
`status` options** — only `select` and `multi_select` options get auto-created.

```
merged                      → Merged
closed, not merged          → Closed
draft                       → Draft
open, reviewDecision:
  CHANGES_REQUESTED         → Changes requested
  APPROVED                  → Approved
  REVIEW_REQUIRED           → In review
  null                      → Open
```

`reviewDecision` is not in the `pull_request` webhook payload. Fetch it with one
GraphQL query (`repository.pullRequest.reviewDecision`) per event — cheaper and
more authoritative than reconstructing it from `pull_request_review` events.

Behind a config flag (`reviewStates: false`) the three review substates collapse
into `Open`, dropping the GraphQL call and the `pull_request_review` trigger.

### 4.4 Setup notes

- Create `Ticket` / `PRs` as a **two-way (dual property) relation** in the UI.
  Writing one side then populates the other automatically.
- Create the three `Status` options on the Tickets DB by hand once. The API can
  set them by name but cannot invent a fourth.
- Share both databases with the integration, or every call 404s.

## 5. Linking PRs to tickets

Resolution order, first level that matches wins; collect **all** keys at that
level (a PR may serve several tickets):

1. **Body directive** — `Ticket: UX-123`, `Closes UX-123`, or a pasted Notion
   page URL. Repeatable across lines.
2. **Branch name** — `ux-123-foo`, `feat/UX-123/bar`.
3. **Title prefix** — `[UX-123] …`.

Key pattern is config-driven, defaulting to the Tickets DB's `ID` prefix.
Resolve each key by querying Tickets with a `unique_id equals <n>` filter.

| Outcome | Behavior |
|---|---|
| ≥1 key resolves | set `Ticket` relation, `Link status = linked` |
| no key found, or key resolves to nothing | relation empty, `Link status = unlinked` |

Keep a saved view in the PR DB filtered to `Link status = unlinked`. That's the
queue of PRs needing a human.

**Never fail the job over an unresolved link.** A Notion problem must not block a
merge.

**Read the existing relation before overwriting it.** If a key is removed from a
PR body, the previously-linked ticket also needs recomputing — otherwise it's
stranded at whatever status it held.

## 6. PR description in the page body

Database rows are pages, so the description is written into the block body as
ordinary blocks — headings, lists, code, paragraphs — rather than a truncated
rich-text property. No wrapper and no sync-owned region — just the rendered
description as ordinary blocks.

**GitHub wins.** Whenever the PR body changes on GitHub, sync replaces the page
body wholesale. Human edits to the body are not preserved — the page is a
mirror, and anything worth keeping belongs in a property or a comment. This is a
deliberate simplification: distinguishing human blocks from synced ones costs an
extra read, an extra stored hash, and a rule that's hard to reason about from
inside Notion.

**Gate rewrites on `Body hash`** — the hash of the GitHub body at last sync. If
it's unchanged, skip the body path entirely without reading anything. Most
events (`closed`, `ready_for_review`, review events) never touch the body, so
this is the common case and it costs zero extra requests. Without the gate,
every event pays a read plus N deletes plus a write, which is where Notion's
~3 req/s starts to matter.

**Mechanics.**

- On create: pass `children` in the create-page call (≤100 blocks; chunk the
  remainder with follow-up appends).
- On replace: property patches don't touch the body. Requires
  `GET /v1/blocks/{page_id}/children` → one `DELETE` per existing block →
  `PATCH …/children` to append the new ones.

**Markdown.** The API takes blocks, not markdown. Use a GFM→blocks converter
(e.g. `@tryfabric/martian`). Strip HTML comments (PR templates are full of them)
and drop images before converting. Wrap the conversion in a try/catch that falls
back to a single plain paragraph — never fail a sync over a strange description.
The 2000-char rich-text limit is per block, not per page, so long bodies are
fine once split.

## 7. Ticket status rule

Let `L` = PRs related to the ticket, and `A` = `L` minus closed-unmerged PRs.

```
ticket.StatusLocked        → leave alone
L empty                    → Draft
A empty                    → Draft       (every attempt was abandoned)
all of A merged            → Completed
otherwise                  → Assigned
```

Closed-unmerged PRs are *excluded* rather than blocking — one abandoned PR
should not pin a ticket at `Assigned` forever. Requiring `A` non-empty stops a
ticket reaching `Completed` on the strength of zero real PRs.

**What sync is allowed to write.** The computed value is not written blindly:

```
computed == current                      → write nothing
computed == Draft AND current != Completed → write nothing
otherwise                                → write computed
```

Sync owns exactly one claim — *every linked PR is merged, so this is done* — and
may both make and retract it. It has no business choosing between `Draft` and
`Assigned`: a ticket is `Assigned` when a person picks it up, which is normally
true long before a PR exists. The first version wrote the computed value
unconditionally, so the nightly sweep shoved every hand-assigned ticket with no
PR yet back to `Draft`. A computed `Draft` is now only ever written to undo a
previous `Completed`.

Read the PR set from Notion with a single `relation contains <ticket_page_id>`
query against the PR database — not from the event payload (which knows about
one repo) and not by reading each related page (N requests).

Only write when the computed status differs from what's stored. Fewer requests,
and Notion's page history stays readable.

`Status locked` is the escape hatch for a human who wants a ticket parked
somewhere sync disagrees with.

## 8. Triggers and workflows

### 8.1 Caller workflow (one per source repo)

```yaml
name: Notion sync
on:
  pull_request:
    types: [opened, reopened, edited, synchronize, closed,
            ready_for_review, converted_to_draft,
            review_requested, review_request_removed]
  pull_request_review:
    types: [submitted, dismissed]

concurrency:
  group: notion-sync-${{ github.repository }}-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  sync:
    uses: <org>/notion-sync-workflow/.github/workflows/sync.yml@v1
    secrets: inherit
```

Notes on each piece:

- **`pull_request`, not `pull_request_target`.** No fork PRs, so secrets are
  always available and the simpler trigger is correct.
- **`synchronize`, despite changing nothing we sync.** GitHub runs no
  `pull_request` workflow on a PR it can't test-merge, so a PR opened with
  merge conflicts never gets its `opened` run, and the push that resolves them
  was the next event — which left the PR out of Notion until the nightly
  reconcile. Minutes are free (§8.2), so a no-op run per push is cheap.
- **No `assigned`/`labeled`/etc.** Those properties were cut from the schema;
  keeping the triggers would just burn Actions minutes.
  `review_requested`/`review_request_removed` stay, because `Reviewers` does.
- **`cancel-in-progress: false` is load-bearing.** Cancelling means dropping the
  *newest* state.
- Drop the `pull_request_review` trigger if `reviewStates` is off.
- Pin to `@v1`, never `@main` — one bad push here shouldn't break every repo.

### 8.2 Permissions and secrets

Least privilege in the reusable workflow:

```yaml
permissions:
  contents: read
  pull-requests: read
```

`ubcuxhub` is a **personal account, not an organization**, so org-level secrets
and variables do not exist. Everything is per-repository, set on each *caller*
repo (plus this one, for reconcile):

| Name | Kind | Notes |
|---|---|---|
| `NOTION_TOKEN` | repo secret | internal integration token |
| `NOTION_PR_DB` | repo secret | not sensitive — a secret for delivery, not secrecy |
| `NOTION_TICKETS_DB` | repo secret | same |

All three are secrets rather than variables because `secrets: inherit` passes
only secrets from caller to called workflow. Without an org scope there is no
dependable way for the reusable workflow to read a caller's *variables*, so
using them would trade a guarantee for a guess.

The cost of no org scope: onboarding a repo is a workflow file **plus three
secrets**, rather than a file alone. At two or three repos that is trivial; past
roughly five it is worth revisiting whether a single scheduled sweep from this
repo (one credential, no per-repo setup) beats the event path.

Both this repo and the source repos are **public**, which settles three things:

- **No Actions access setting needed.** A public repo's action and reusable
  workflow can be referenced by anyone. (Were this repo private, it would need
  *Settings → Actions → General → Access → "Accessible from repositories owned
  by the organization"*, and could only be used by repos inside `ubcuxhub`.)
- **Actions minutes are free and unlimited**, so there is no budget to keep the
  event path inside.
- **Fork PRs become possible**, and GitHub withholds secrets from them on
  `pull_request`. The caller workflow therefore guards with
  `if: github.event.pull_request.head.repo.full_name == github.repository`, so a
  contributor's PR skips the sync rather than failing red. Reconcile picks those
  PRs up on its next sweep.

The trade is that scheduled workflows in a public repo are **auto-disabled after
60 days without repository activity** (GitHub emails first). A repo this quiet
will hit it, and a disabled poller means Notion edits silently stop reaching
GitHub — so the nightly run re-enables its own workflow through the API.

## 9. Adding a repo

1. Add the repo to `sync.config.json` in this repo.
2. Copy the caller workflow into `.github/workflows/notion-sync.yml` there.
3. Set `NOTION_TOKEN`, `NOTION_TICKETS_DB`, `NOTION_PR_DB` as repo secrets on it.
4. Run reconcile with `--repos <owner/repo>` to backfill existing PRs.

Step 3 is the per-repo tax of a personal account (§8.2). Rotating the Notion
token means updating every repo.

## 10. Reconcile and backfill

One code path, three entry points: `event` (default), `reconcile` (sweep),
`backfill` (`reconcile` with an unbounded `--since`).

Reconcile does:

1. For each configured repo: list PRs updated since `--since`, plus all open PRs
   regardless of age → upsert each.
2. Query the PR DB for pages whose `Synced at` predates the window → re-fetch
   from GitHub → repair, or flag if the PR is gone. Never auto-delete.
3. Query Tickets for `Status != Completed AND Status locked = false` →
   recompute.

### Why event-only sync is not sufficient

Each of these fails **silently** — a ticket stuck at `Assigned` looks exactly
like a ticket genuinely in progress:

- **Dropped events are gone forever.** A Notion 429, a 5xx, a transient network
  failure — the run fails and nothing retries it. GitHub does not redeliver
  workflow runs.
- **Notion-side edits emit no event.** Ticket status is derived from the
  relation set; a human editing that set in Notion invalidates the status with
  nothing on the GitHub side to trigger a correction.
- **Tickets created after their PRs merged stay orphaned.** A PR body referencing
  a ticket that doesn't exist yet resolves `unlinked`; once merged, that PR emits
  no further events and nothing revisits it. This is the most common case in
  practice.
- **Coverage gaps** — a repo added before its workflow was installed, an Actions
  incident, a bad `@v1` tag.
- **Cross-repo ticket races** (§11).

### Credentials

Reconcile reads PRs across every configured repo, and `GITHUB_TOKEN` is scoped
to the repo it runs in. It needs either a **GitHub App** installed on the org
(preferred — scoped, auto-rotating) or a fine-grained PAT with
`pull_requests: read` — now **read & write**, for write-back (§16) — stored as
a secret in this repo. The per-repo event workflows need neither; they only
talk to Notion.

### Recommended sequencing

Ship the event path first, with reconcile available via `workflow_dispatch` and
runnable locally against a personal token. Add the GitHub App and the one-line
`schedule:` (nightly) once the event path is stable. Do not skip *building*
reconcile — without it there's no way to repair Notion when it drifts.

Scheduled-workflow caveats: they run only from the default branch; GitHub's cron
drifts by 10+ minutes under load and occasionally skips a run. Fine for a
nightly self-heal. **This repo is public, so the schedule is auto-disabled after
60 days with no commits** — GitHub emails first, and any commit resets the
clock, but a sync that quietly stops healing itself is the failure mode to watch
for.

## 11. Concurrency, idempotency, rate limits

- **Upsert** = query PR DB on `URL equals` → patch if found, create if not. The
  extra read per event is worth the idempotency.
- **Per-PR serialization** via the `concurrency` group in §8.1.
- **Cross-repo ticket races** — two PRs on one ticket merging simultaneously in
  different repos can't be locked from Actions. Both jobs compute the same
  target from a fresh read, so the common case converges; the pathological
  interleaving is repaired by reconcile. Not worth engineering around.
- **Notion rate limit** is ~3 req/s average. A single PR event is 3–6 requests
  (query, GraphQL, patch, sometimes body ops, one query per linked ticket).
  Reconcile and backfill need a queue with ~300 ms spacing.
- **Retry** with exponential backoff on `429` (honour `Retry-After`), `409
  conflict_error`, and 5xx. Cap at ~5 attempts, then fail the job loudly.

## 12. Implementation

**Stack.** TypeScript, `@actions/core`, `@octokit/rest` + `@octokit/graphql`,
plain `fetch` for Notion (the official client is fine; the surface used is
small).

**Pinned to `Notion-Version: 2025-09-03`.** The version is chosen per request by
the client — a required header, not a workspace setting. Probing the workspace
with both `2022-06-28` and `2025-09-03` confirmed the newer model applies: the
database object carries a `data_sources` array and an *empty* `properties` map.

`2022-06-28` would also work and is simpler, but it is the pre-data-source
model; building on it would mean a rewrite later. The newer version costs one
resolution step and these deltas:

| Operation | Under `2025-09-03` |
|---|---|
| Read schema | `GET /v1/data_sources/{ds}` |
| Query rows | `POST /v1/data_sources/{ds}/query` |
| Create page | parent `{"type":"data_source_id","data_source_id":…}` |
| Relation target | property refers to a `data_source_id` |

Database ids stay in env and secrets — those are what a human can read off a
URL — and `NotionClient.dataSourceId()` resolves them once per process. The pin
is what stops an upstream change breaking sync unannounced.

**Shape: pure core, I/O at the edges.**

```
src/
  core/
    deriveState.ts         (pr, reviewDecision) → State
    resolveTicketKeys.ts   (body, branch, title) → TicketRef[]
    computeTicketStatus.ts (PrOutcome[])         → Status
    renderBody.ts          (markdown)            → Block[]
  notion/     client, schema+verifier, prs (upsert), tickets, body, pages
  github/     event payload + REST normalization, reviewDecision
  modes/      syncPr (shared), event.ts, reconcile.ts, summary.ts
  index.ts    action entrypoint      cli.ts   local entrypoint
  run.ts      bootstrap (config, data source resolution, schema check)
action.yml    dist/            (bundled by ncc — committed)
sync.config.json
.github/workflows/
  sync.yml        (workflow_call — the reusable workflow)
  reconcile.yml   (workflow_dispatch, + schedule later)
docs/caller-workflow.yml   (copy-paste template for source repos)
docs/notion-setup.md       (the hand-built schema)
```

**How the code reaches the runner.** A reusable workflow cannot
`actions/checkout` a *private* sibling repo without a PAT. So the sync logic
ships as a **JS action** (`action.yml` + committed `dist/`), and the reusable
workflow references it as `uses: <org>/notion-sync-workflow@v1`. That reference
is permitted by the same org-access setting §8.2 already requires, and needs no
extra secret. Callers keep the five-line `secrets: inherit` form.

Those four core functions hold every rule in the system and are trivially
unit-testable with fixture payloads. Untestable sync logic is the usual failure
mode for tools like this.

**`sync.config.json`** — central, so adding a repo doesn't mean editing its
workflow:

```json
{
  "repos": ["org/ux-hub-web", "org/ux-hub-tokens", "org/ux-hub-docs"],
  "ticketKeyPrefix": "UX",
  "reviewStates": true,
  "reconcileSinceDays": 14
}
```

**Dry-run** (`DRY_RUN=1`) logs the intended patch without writing. Makes the
first week survivable.

**Job summary** via `$GITHUB_STEP_SUMMARY`: what was upserted, which tickets
changed status, which links failed to resolve.

## 13. Edge cases

| Case | Behavior |
|---|---|
| PR reopened after close | recompute; ticket may leave `Completed` |
| Ticket manually completed early | use `Status locked`, else sync pulls it back |
| Ticket key edited mid-life | `edited` re-resolves; old relation dropped, **both** old and new tickets recomputed |
| Ticket archived/trashed in Notion | relation resolves empty → `unlinked`, warn |
| PR page deleted in Notion | next event's upsert query misses → recreated |
| Repo renamed / PR deleted | reconcile flags pages it can't re-fetch; no auto-delete |
| Same PR number in two repos | `URL` is the key, so no collision |
| Body >100 blocks | chunk the append; first 100 in the create call |
| Human edits the page body | overwritten next time the PR body changes (§6) |
| PR opened as draft, then ready | `converted_to_draft` / `ready_for_review` both re-derive `State` |
| Reviewer added in Notion is not a collaborator | GitHub 422 → `Reviewers` reverts, reason in `Sync error` (§16) |
| Requested reviewer submits a review | GitHub drops them from requested reviewers → they leave `Reviewers` |
| Ticket unlinked in Notion but named in a hand-written body line | region updated, ticket stays linked, run warns |
| Notion edit on a row that predates write-back | shadow empty → GitHub wins once, then edits flow |

## 14. Decided against

- **Auto-creating tickets.** An `unlinked` PR does not mint a `Draft` ticket. It
  sits in the triage view (§5) until a human links it. Tickets are authored
  deliberately; a sync that invents them turns the kanban into a PR list.
- **Failure notification.** No Slack, no issue-filing, no alerting channel. A
  failed run surfaces as a red job and GitHub's own notification. Reconcile
  (§10) is what makes a missed run non-fatal, so a failure isn't urgent enough
  to justify another integration.

## 15. Milestones

1. ✅ Notion schema created by hand; integration connected to both DBs.
2. ✅ Core functions + fixture tests. No I/O.
3. ✅ Notion client: upsert, body, ticket queries. Verified against the workspace.
4. ✅ Action + reusable workflow; reconcile mode via `workflow_dispatch`.
5. Push to GitHub, tag `v1`, enable org access on this repo.
6. One pilot repo. Watch it for a few days.
7. Roll out to remaining repos; backfill each with reconcile.
8. GitHub App (cross-repo reads) + nightly schedule.

### Verified end to end

Against the live workspace, driving the bundled `dist/` with real event payloads:

| | |
|---|---|
| Schema | all 21 properties, options, `UX` prefix, two-way relation |
| Filters | `unique_id equals`, `relation contains`, `url equals`, `status does_not_equal`, `date before/is_empty` |
| Create / update | page written, all 15 properties correct |
| Body | 3.8kB markdown → 20 blocks (headings, lists, paragraphs) |
| Idempotency | re-sync updates in place; one page per URL; body skipped when hash matches |
| Ticket status | Draft → Completed → Assigned → Completed as PR state changed |
| Unlink | reference removed → relation cleared → *previous* ticket recomputed to Draft |
| `Status locked` | merged PR linked, status held at Assigned |

## 16. Notion → GitHub write-back

Two PR-row properties are editable in Notion and flow back to GitHub:

| Property | Written to GitHub as |
|---|---|
| `Ticket` | a `Ticket:` line in a marked region of the PR description |
| `Reviewers` | requested reviewers on the PR |

GitHub stays the single source of truth. A Notion edit is turned into a GitHub
write, and the row is then written from what GitHub holds — so a link made in
Notion survives a rebuild of the database, because GitHub remembers it. Every
other property describes something that already happened on GitHub and stays
one-directional; `State` in particular is never an action taken from a dropdown.

### Detecting a human edit: shadows

A single snapshot cannot tell "someone added a reviewer in Notion" from "GitHub
dropped a reviewer and Notion is stale". Each write-back property has a hidden
shadow (`Ticket shadow`, `Reviewers shadow`) holding what GitHub said at the
last sync — the same idea as `Body hash`. With it, a three-way merge per element:

```
added   = notion − shadow
removed = shadow − notion
desired = (github ∪ added) − removed
```

Merging elements rather than whole values means there is no conflict case: a
reviewer added in Notion and another requested on GitHub in the same window
both survive. An empty shadow (a row from before write-back) means no baseline,
so GitHub wins and the shadow is initialised. `src/core/mergeField.ts`.

Only runs holding the cross-repo PAT push. The per-repo event workflows are
read-only: they write the merged value to Notion but leave the shadow at
GitHub's, so the edit stays pending for the poller rather than being
overwritten.

### The description region

```
<!-- notion-sync:tickets -->
Ticket: UX-3, UX-7
<!-- /notion-sync:tickets -->
```

Replaced wholesale on every push, so relinking and unlinking never touch the
rest of the description. The markers are comments — invisible on GitHub and
stripped from the Notion body — and the line between them is an ordinary
directive (§5). Two consequences:

- **The region's presence makes the body authoritative.** Once it exists, the
  parser does not fall back to the branch or title, even when it says
  `Ticket: none`. Otherwise unlinking a branch-derived ticket would undo itself.
- **It only speaks for itself.** A ticket named in a hand-written line elsewhere
  in the description cannot be unlinked from Notion; the run warns instead.

A push costs one extra event run: editing the description fires
`pull_request: edited`, which re-syncs the row and finds nothing to change.

### Trigger: polling, not webhooks

Notion's "Send webhook" automation (available on Plus) was tested and rejected:

- It sends its own JSON envelope with no way to shape the body, and GitHub's
  `repository_dispatch` requires a top-level `event_type` — so it cannot call
  GitHub directly and would need a hosted relay.
- A dropped webhook would lose the edit silently: the next reconcile writes
  GitHub's value over it.

A 10-minute poll has no infrastructure and heals itself: a missed or delayed
run is covered by the next. The poller queries rows edited in the last 24h
(`pollLookbackHours`, sized for cron runs observed hours late) and keeps only
those whose values differ from their shadows. That filter is also what stops it
re-processing its own writes; a quiet poll is one Notion query.

### Failure handling

GitHub rejects a reviewer who is not a collaborator, is the PR author, or is a
typo — Notion multi-select accepts anything. Reviewers are requested one login
per call so one bad name does not block the rest. A failed push reverts the
Notion field to GitHub's value and writes the reason to `Sync error`, which
stays until the next push attempt. Reviewer edits on closed or merged PRs are
ignored.

### Permissions

`RECONCILE_GITHUB_TOKEN` needs **Pull requests: read & write** on each repo.
That is an escalation: the token can now edit descriptions and request reviews
wherever it is granted, and GitHub attributes those writes to its owner. The
per-repo event workflows stay `contents: read`.

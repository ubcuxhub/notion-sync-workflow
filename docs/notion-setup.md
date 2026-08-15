# Notion setup

The schema sync depends on. Both databases are built by hand: the `status` and
`ID` property types **cannot be created through the API**, so a bootstrap script
is not possible.

Run `npm run verify-schema` after any change here — it checks every property
name, type and option against what the code expects.

## Tickets

| Property | Type | Notes |
|---|---|---|
| `Name` | Title | |
| `ID` | ID (unique id) | prefix `UX` — Notion mints `UX-1`, `UX-2`… |
| `Status` | Status | `Draft`, `Assigned`, `Completed` |
| `PRs` | Relation → Pull Requests | created automatically by the relation below |
| `Status locked` | Checkbox | when ticked, sync never touches `Status` |
| `Auto-updated at` | Date | last time sync wrote `Status` |

Create the three `Status` options by **renaming Notion's defaults**, so each
stays in its default group:

| Default | Rename to | Group |
|---|---|---|
| Not started | `Draft` | To-do |
| In progress | `Assigned` | In progress |
| Done | `Completed` | Complete |

## Pull Requests

Every row is machine-managed. Nothing here should be edited by hand — the page
body included, which is overwritten whenever the PR description changes.

| Property | Type | Notes |
|---|---|---|
| `Name` | Title | `#123 · <PR title>` |
| `URL` | URL | the row's identity; upserts match on it |
| `State` | Select | `Draft`, `Open`, `In review`, `Changes requested`, `Approved`, `Merged`, `Closed` |
| `Repo` | Select | `owner/name` |
| `Number` | Number | plain, no comma separator |
| `Author` | Select | GitHub login |
| `Reviewers` | Multi-select | requested reviewers |
| `Opened` / `Merged` / `Closed` / `Last activity` | Date | |
| `Ticket` | Relation → Tickets | two-way; reverse property named `PRs` |
| `Link status` | Select | `linked`, `unlinked` (lowercase) |
| `Body hash` | Text | hidden; gates body rewrites |
| `Synced at` | Date | hidden; staleness detection for reconcile |

`State` and `Link status` must be **Select**, not Status. The API cannot create
new Status options, so a Status property here would break the first time GitHub
produced a value the database had never seen.

## The relation

Create it from the Pull Requests side:

- Property `Ticket`, type Relation, target Tickets
- "Show on Tickets" **on**, reverse property named `PRs`
- No page limit on either side — a ticket has many PRs, and a PR may serve more
  than one ticket

## Connecting the integration

Both databases must be connected to the integration or every API call 404s with
a message that does not mention sharing:

`•••` → **Connections** → **Connect to** → your integration

If a database is inline inside a parent page, connect the parent instead.

## Views worth having

- Tickets: board grouped by `Status`, columns ordered Draft → Assigned → Completed
- Pull Requests: table filtered to `Link status = unlinked` — the triage queue
  for PRs whose ticket reference did not resolve
- Pull Requests: hide `Body hash` and `Synced at` everywhere

## Ids

Database ids are the 32-hex-char segment of each database's URL. They go in
`.env` locally and in org variables for Actions. The code resolves each to a
*data source id* at startup — that indirection is the 2025-09-03 API model, and
is handled internally.

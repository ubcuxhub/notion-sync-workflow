import type { Octokit } from "@octokit/rest";
import type { SyncConfig } from "../config.js";
import { fetchPrsForReconcile } from "../github/client.js";
import type { SyncContext } from "../notion/context.js";
import { findStalePrPages } from "../notion/prs.js";
import { findUnfinishedTickets, recomputeTicket } from "../notion/tickets.js";
import { PR_PROPS } from "../notion/schema.js";
import * as p from "../notion/pages.js";
import { syncPr } from "./syncPr.js";
import { emptySummary, record, type RunSummary } from "./summary.js";

export interface ReconcileOptions {
  repos: string[];
  since: Date;
}

/**
 * Repair drift. Same code path as backfill — only `since` differs.
 *
 * Event-driven sync always drifts: dropped runs are never redelivered, Notion
 * edits emit no GitHub event, and a ticket created after its PRs merged is
 * never revisited because merged PRs stop producing events. This is what makes
 * those cases self-correcting instead of silently wrong.
 */
export async function runReconcile(
  ctx: SyncContext,
  gh: Octokit,
  config: SyncConfig,
  options: ReconcileOptions,
): Promise<RunSummary> {
  const summary = emptySummary();
  const ticketsToRecompute = new Set<string>();

  // 1. Sweep GitHub — every recently-touched PR, plus all open ones.
  for (const repo of options.repos) {
    let prs;
    try {
      prs = await fetchPrsForReconcile(gh, repo, options.since);
    } catch (err) {
      // One unreachable repo (renamed, access revoked) should not abandon the rest.
      summary.warnings.push(`could not list PRs for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    ctx.log(`${repo}: ${prs.length} PR(s) to check`);
    for (const pr of prs) {
      const result = await syncPr(ctx, gh, pr, { reviewStates: config.reviewStates, canPush: true });
      record(summary, result);
      for (const id of result.ticketsToRecompute) ticketsToRecompute.add(id);
    }
  }

  // 2. Sweep Notion for pages this run did not touch — they may reference PRs in
  //    repos that have since been removed from config, or that no longer exist.
  const synced = new Set(summary.prs.map((pr) => `${pr.repo}#${pr.number}`));
  for (const page of await findStalePrPages(ctx, options.since)) {
    const repo = p.readSelect(page, PR_PROPS.repo);
    const number = page.properties[PR_PROPS.number]?.number;
    if (!repo || !number || synced.has(`${repo}#${number}`)) continue;
    // Never auto-delete: a page we cannot explain is better than one silently gone.
    summary.warnings.push(`stale PR page not covered by this sweep: ${repo}#${number}`);
  }

  // 3. Recompute every ticket that could have moved.
  for (const id of await findUnfinishedTickets(ctx)) ticketsToRecompute.add(id);
  for (const ticketId of ticketsToRecompute) {
    const recomputed = await recomputeTicket(ctx, ticketId);
    if (recomputed.changed) {
      summary.ticketChanges.push({ ticketId, from: recomputed.from ?? "—", to: recomputed.to });
    }
  }

  return summary;
}

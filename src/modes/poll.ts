import type { Octokit } from "@octokit/rest";
import type { SyncConfig } from "../config.js";
import { fetchPr } from "../github/client.js";
import type { SyncContext } from "../notion/context.js";
import * as p from "../notion/pages.js";
import { findPendingPrPages } from "../notion/prs.js";
import { PR_PROPS } from "../notion/schema.js";
import { recomputeTicket } from "../notion/tickets.js";
import { emptySummary, record, type RunSummary } from "./summary.js";
import { syncPr } from "./syncPr.js";

/**
 * Push Notion edits to Ticket and Reviewers back to GitHub.
 *
 * Notion cannot call us when a row changes, so this runs on a short cron and
 * asks which rows hold an edit GitHub has not seen. The lookback is far longer
 * than the cron interval on purpose: scheduled runs are delayed by hours and
 * sometimes skipped, and a row outside the window would wait for the nightly
 * reconcile. Rows with nothing pending cost nothing beyond the one query.
 */
export async function runPoll(
  ctx: SyncContext,
  gh: Octokit,
  config: SyncConfig,
  options: { since: Date },
): Promise<RunSummary> {
  const summary = emptySummary();
  const ticketsToRecompute = new Set<string>();

  const pages = await findPendingPrPages(ctx, options.since);
  ctx.log(`${pages.length} PR row(s) with a Notion edit to push`);

  for (const page of pages) {
    const repo = p.readSelect(page, PR_PROPS.repo);
    const number = p.readNumber(page, PR_PROPS.number);
    if (!repo || !number) {
      summary.warnings.push(`PR row ${page.id} has no Repo or Number — cannot find its PR`);
      continue;
    }
    let pr;
    try {
      pr = await fetchPr(gh, repo, number);
    } catch (err) {
      // Usually a repo the token was never granted. One unreachable PR should
      // not hold up the rest.
      summary.warnings.push(`could not fetch ${repo}#${number}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const result = await syncPr(ctx, gh, pr, { reviewStates: config.reviewStates, canPush: true });
    record(summary, result);
    for (const id of result.ticketsToRecompute) ticketsToRecompute.add(id);
  }

  for (const ticketId of ticketsToRecompute) {
    const recomputed = await recomputeTicket(ctx, ticketId);
    if (recomputed.changed) {
      summary.ticketChanges.push({ ticketId, from: recomputed.from ?? "—", to: recomputed.to });
    }
  }

  return summary;
}

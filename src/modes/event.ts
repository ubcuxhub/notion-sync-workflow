import type { Octokit } from "@octokit/rest";
import type { SyncConfig } from "../config.js";
import type { SyncContext } from "../notion/context.js";
import { recomputeTicket } from "../notion/tickets.js";
import type { PullRequest } from "../types.js";
import { syncPr } from "./syncPr.js";
import type { RunSummary } from "./summary.js";
import { emptySummary, record } from "./summary.js";

/** Sync a single PR and recompute every ticket it touches. */
export async function runEvent(
  ctx: SyncContext,
  gh: Octokit,
  pr: PullRequest,
  config: SyncConfig,
): Promise<RunSummary> {
  const summary = emptySummary();

  // The event workflow's token is read-only: a Notion edit waits for the poller.
  const result = await syncPr(ctx, gh, pr, { reviewStates: config.reviewStates, canPush: false });
  record(summary, result);

  for (const ticketId of result.ticketsToRecompute) {
    const recomputed = await recomputeTicket(ctx, ticketId);
    if (recomputed.changed) {
      summary.ticketChanges.push({ ticketId, from: recomputed.from ?? "—", to: recomputed.to });
    }
  }

  return summary;
}

import type { Octokit } from "@octokit/rest";
import type { SyncConfig } from "../config.js";
import type { SyncContext } from "../notion/context.js";
import { recomputeTicket } from "../notion/tickets.js";
import type { PullRequest } from "../types.js";
import { syncPr } from "./syncPr.js";
import type { RunSummary } from "./summary.js";
import { emptySummary } from "./summary.js";

/** Sync a single PR and recompute every ticket it touches. */
export async function runEvent(
  ctx: SyncContext,
  gh: Octokit,
  pr: PullRequest,
  config: SyncConfig,
): Promise<RunSummary> {
  const summary = emptySummary();

  const result = await syncPr(ctx, gh, pr, { reviewStates: config.reviewStates });
  summary.prs.push({ repo: pr.repo, number: pr.number, state: result.state, created: result.created });
  if (!result.linked) summary.unlinked.push(`${pr.repo}#${pr.number}`);

  for (const ticketId of result.ticketsToRecompute) {
    const recomputed = await recomputeTicket(ctx, ticketId);
    if (recomputed.changed) {
      summary.ticketChanges.push({ ticketId, from: recomputed.from ?? "—", to: recomputed.to });
    }
  }

  return summary;
}

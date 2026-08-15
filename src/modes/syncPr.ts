import type { Octokit } from "@octokit/rest";
import { deriveState } from "../core/deriveState.js";
import { resolveTicketRefs } from "../core/resolveTicketKeys.js";
import { fetchReviewDecision } from "../github/client.js";
import type { SyncContext } from "../notion/context.js";
import { upsertPr } from "../notion/prs.js";
import { resolveRefs } from "../notion/tickets.js";
import type { PullRequest } from "../types.js";

export interface SyncPrResult {
  pr: PullRequest;
  created: boolean;
  state: string;
  linked: boolean;
  /** Tickets to recompute: the ones it links to now, plus any it just stopped linking to. */
  ticketsToRecompute: string[];
}

/**
 * Sync one PR into Notion. Shared by the event path and the reconcile sweep —
 * they differ only in where the PullRequest came from.
 */
export async function syncPr(
  ctx: SyncContext,
  gh: Octokit,
  pr: PullRequest,
  options: { reviewStates: boolean },
): Promise<SyncPrResult> {
  const reviewDecision = options.reviewStates
    ? await fetchReviewDecision(gh, pr.repo, pr.number, (msg) => ctx.log(`  warning: ${msg}`))
    : null;
  const state = deriveState(pr, reviewDecision);

  const refs = resolveTicketRefs(pr, ctx.ticketKeyPrefix);
  const ticketIds = await resolveRefs(ctx, refs);
  const linkStatus = ticketIds.length > 0 ? "linked" : "unlinked";

  const result = await upsertPr(ctx, pr, state, ticketIds, linkStatus);

  const verb = ctx.dryRun ? (result.created ? "would create" : "would update") : result.created ? "created" : "updated";
  ctx.log(
    `${verb} ${pr.repo}#${pr.number} — ${state}` +
      (ticketIds.length ? ` → ${ticketIds.length} ticket(s)` : " (unlinked)") +
      (result.bodyRewritten ? " (+ body)" : ""),
  );

  return {
    pr,
    created: result.created,
    state,
    linked: ticketIds.length > 0,
    // A ticket the PR was unlinked from still needs recomputing, or it keeps a
    // status derived from a PR that no longer belongs to it.
    ticketsToRecompute: [...new Set([...ticketIds, ...result.previousTicketIds])],
  };
}

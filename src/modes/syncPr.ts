import type { Octokit } from "@octokit/rest";
import { deriveState } from "../core/deriveState.js";
import { mergeSet, parseShadow } from "../core/mergeField.js";
import { normalizeId, resolveTicketRefs } from "../core/resolveTicketKeys.js";
import { writeTicketRegion } from "../core/ticketRegion.js";
import { fetchReviewDecision } from "../github/client.js";
import { removeReviewer, requestReviewer, updateBody, type WriteContext } from "../github/write.js";
import type { SyncContext } from "../notion/context.js";
import * as p from "../notion/pages.js";
import type { NotionPage } from "../notion/pages.js";
import { findPrPage, readTicketIds, upsertPr } from "../notion/prs.js";
import { PR_PROPS } from "../notion/schema.js";
import { resolveRefs, ticketKeys } from "../notion/tickets.js";
import type { PullRequest } from "../types.js";

export interface SyncPrOptions {
  reviewStates: boolean;
  /**
   * Whether Notion edits to Ticket and Reviewers may be written to GitHub. Only
   * runs holding the cross-repo PAT can; the per-repo event workflows are
   * read-only, so they keep a pending edit in Notion for the poller to push.
   */
  canPush: boolean;
}

export type SyncOutcome = "created" | "updated" | "unchanged";

export interface SyncPrResult {
  pr: PullRequest;
  outcome: SyncOutcome;
  state: string;
  linked: boolean;
  /** Tickets to recompute: the ones it links to now, plus any it just stopped linking to. */
  ticketsToRecompute: string[];
  /** Human-readable GitHub writes made from Notion edits. */
  pushed: string[];
  warnings: string[];
}

/**
 * Sync one PR into Notion, first pushing any Notion edit to Ticket or Reviewers
 * back to GitHub. Shared by the event path, the poller and the reconcile sweep —
 * they differ only in where the PullRequest came from and whether they may push.
 *
 * GitHub stays the source of truth: a Notion edit becomes a GitHub write, and
 * the row is then written from what GitHub holds. See core/mergeField.ts for
 * how a Notion edit is told apart from a GitHub change.
 */
export async function syncPr(
  ctx: SyncContext,
  gh: Octokit,
  pr: PullRequest,
  options: SyncPrOptions,
): Promise<SyncPrResult> {
  const existing = await findPrPage(ctx, pr.url);
  const w: WriteContext = { gh, dryRun: ctx.dryRun, log: ctx.log };
  const pushed: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let attempted = false;

  // ---- Ticket ----
  let githubTickets = await ticketsOnGitHub(ctx, pr);
  const tickets = mergeSet(
    shadowOf(existing, PR_PROPS.ticketShadow),
    existing ? readTicketIds(existing) : githubTickets,
    githubTickets,
  );
  if (options.canPush && tickets.pending) {
    attempted = true;
    const keys = await ticketKeys(ctx, tickets.desired);
    const body = writeTicketRegion(pr.body, keys);
    const res = await updateBody(w, pr.repo, pr.number, body);
    if (res.ok) {
      pr = { ...pr, body };
      githubTickets = await ticketsOnGitHub(ctx, pr);
      pushed.push(`tickets → ${keys.join(", ") || "none"}`);
      // The region can only speak for itself. A ticket named in a hand-written
      // line elsewhere in the description survives an unlink in Notion.
      const stuck = githubTickets.filter((id) => !tickets.desired.includes(id));
      if (stuck.length) {
        const names = (await ticketKeys(ctx, stuck)).join(", ") || `${stuck.length} ticket(s)`;
        warnings.push(`${pr.repo}#${pr.number}: ${names} unlinked in Notion but still named in the PR description — remove it on GitHub`);
      }
    } else if (res.error) {
      errors.push(res.error);
    }
  }

  // ---- Reviewers ----
  const reviewers = mergeSet(
    shadowOf(existing, PR_PROPS.reviewersShadow),
    existing ? p.readMultiSelect(existing, PR_PROPS.reviewers) : pr.reviewers,
    pr.reviewers,
  );
  if (options.canPush && reviewers.pending) {
    if (pr.merged || pr.closedAt) {
      // Nobody reviews a closed PR; GitHub's (empty) list wins.
      ctx.log(`  ignoring a Reviewers edit on closed ${pr.repo}#${pr.number}`);
    } else {
      attempted = true;
      const now = new Set(pr.reviewers);
      // One login per call: GitHub rejects the whole batch for one bad login,
      // which would block the valid ones alongside a typo.
      for (const login of reviewers.desired.filter((l) => !now.has(l))) {
        const res = await requestReviewer(w, pr.repo, pr.number, login);
        if (res.ok) {
          now.add(login);
          pushed.push(`requested ${login}`);
        } else if (res.error) errors.push(res.error);
      }
      for (const login of pr.reviewers.filter((l) => !reviewers.desired.includes(l))) {
        const res = await removeReviewer(w, pr.repo, pr.number, login);
        if (res.ok) {
          now.delete(login);
          pushed.push(`removed ${login}`);
        } else if (res.error) errors.push(res.error);
      }
      pr = { ...pr, reviewers: [...now] };
    }
  }

  // After the pushes, so a requested review is reflected in the state.
  const reviewDecision = options.reviewStates
    ? await fetchReviewDecision(gh, pr.repo, pr.number, (msg) => ctx.log(`  warning: ${msg}`))
    : null;
  const state = deriveState(pr, reviewDecision);

  // A pusher writes what GitHub now holds — a failed push reverts the Notion
  // edit, with the reason in Sync error. A non-pusher keeps the edit pending:
  // the field shows the merged value while the shadow stays at GitHub's.
  const ticketIds = options.canPush ? githubTickets : tickets.desired;
  const reviewerLogins = options.canPush ? pr.reviewers : reviewers.desired;
  for (const warning of warnings) ctx.log(`  warning: ${warning}`);

  const result = await upsertPr(ctx, existing, pr, {
    state,
    ticketIds,
    linkStatus: ticketIds.length > 0 ? "linked" : "unlinked",
    reviewers: reviewerLogins,
    ticketShadow: githubTickets,
    reviewersShadow: pr.reviewers,
    // Kept until the next push attempt, so the person who made the edit sees why
    // it bounced even after an unrelated event re-syncs the row.
    syncError: attempted ? errors.join("\n") : existing ? p.readText(existing, PR_PROPS.syncError) : "",
  });

  const outcome: SyncOutcome = result.created ? "created" : result.changed ? "updated" : "unchanged";
  const verb = ctx.dryRun && outcome !== "unchanged" ? `would ${outcome.replace(/d$/, "")}` : outcome;
  ctx.log(
    `${verb} ${pr.repo}#${pr.number} — ${state}` +
      (ticketIds.length ? ` → ${ticketIds.length} ticket(s)` : " (unlinked)") +
      (result.bodyRewritten ? " (+ body)" : ""),
  );

  const previousTicketIds = existing ? readTicketIds(existing) : [];
  return {
    pr,
    outcome,
    state,
    linked: ticketIds.length > 0,
    // A ticket the PR was unlinked from still needs recomputing, or it keeps a
    // status derived from a PR that no longer belongs to it.
    ticketsToRecompute: [...new Set([...ticketIds, ...previousTicketIds])],
    pushed,
    warnings: [...warnings, ...errors.map((e) => `${pr.repo}#${pr.number}: ${e}`)],
  };
}

async function ticketsOnGitHub(ctx: SyncContext, pr: PullRequest): Promise<string[]> {
  const ids = await resolveRefs(ctx, resolveTicketRefs(pr, ctx.ticketKeyPrefix));
  return ids.map(normalizeId);
}

function shadowOf(page: NotionPage | undefined, prop: string): string[] | null {
  return page ? parseShadow(p.readText(page, prop)) : null;
}

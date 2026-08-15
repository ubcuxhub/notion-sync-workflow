import type { PrState } from "../notion/schema.js";
import type { PullRequest, ReviewDecision } from "../types.js";

/**
 * Map a PR plus GitHub's review verdict onto the State select.
 *
 * Terminal states win over everything: a merged PR that was in "Changes
 * requested" is Merged, not still under review. Draft outranks review state for
 * the same reason in the other direction — nobody is waiting on a draft.
 *
 * `reviewDecision` is null when review substates are disabled in config, which
 * collapses the middle three into Open.
 */
export function deriveState(pr: PullRequest, reviewDecision: ReviewDecision): PrState {
  if (pr.merged) return "Merged";
  if (pr.closedAt) return "Closed";
  if (pr.draft) return "Draft";

  switch (reviewDecision) {
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "APPROVED":
      return "Approved";
    case "REVIEW_REQUIRED":
      return "In review";
    default:
      return "Open";
  }
}

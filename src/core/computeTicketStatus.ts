import type { TicketStatus } from "../notion/schema.js";
import type { PrOutcome } from "../types.js";

/**
 * Derive a ticket's status from the PRs linked to it.
 *
 * Closed-but-unmerged PRs are excluded rather than treated as blockers: one
 * abandoned attempt should not pin a ticket at Assigned forever. Requiring the
 * remainder to be non-empty stops a ticket reaching Completed on the strength
 * of zero real PRs — a ticket whose every PR was abandoned is back to Draft,
 * because no work stands.
 */
export function computeTicketStatus(prs: PrOutcome[]): TicketStatus {
  if (prs.length === 0) return "Draft";

  const live = prs.filter((pr) => pr.merged || !pr.closed);
  if (live.length === 0) return "Draft";

  return live.every((pr) => pr.merged) ? "Completed" : "Assigned";
}

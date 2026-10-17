import type { TicketStatus } from "../notion/schema.js";
import type { PrOutcome } from "../types.js";

/**
 * Derive a ticket's status from the PRs linked to it.
 *
 * Closed-but-unmerged PRs are excluded rather than treated as blockers: one
 * abandoned attempt should not pin a ticket at In review forever. Requiring the
 * remainder to be non-empty stops a ticket reaching Completed on the strength
 * of zero real PRs — a ticket whose every PR was abandoned is back to Draft,
 * because no work stands.
 */
export function computeTicketStatus(prs: PrOutcome[]): TicketStatus {
  if (prs.length === 0) return "Draft";

  const live = prs.filter((pr) => pr.merged || !pr.closed);
  if (live.length === 0) return "Draft";

  return live.every((pr) => pr.merged) ? "Completed" : "In review";
}

/**
 * Decide what to actually write, given where the ticket is now. Null means
 * leave it alone.
 *
 * Sync owns exactly two claims: "a linked PR is open, so this is in review" and
 * "every linked PR is merged, so this is done." It may make those claims and
 * it may retract them. It has no business deciding between Draft and
 * Assigned — a ticket is Assigned when someone picks it up, which is normally
 * true long before a PR exists. Demoting those back to Draft on every sweep is
 * how this fought its users on the first day.
 *
 * So a computed Draft is only ever written to undo one of sync's own claims.
 * Retracting In review lands on Assigned, not Draft: the PR was abandoned, but
 * whoever opened it still has the ticket.
 */
export function decideTicketWrite(current: string | undefined, computed: TicketStatus): TicketStatus | null {
  if (computed === current) return null;
  if (computed === "Draft") {
    if (current === "Completed") return "Draft";
    if (current === "In review") return "Assigned";
    return null;
  }
  return computed;
}

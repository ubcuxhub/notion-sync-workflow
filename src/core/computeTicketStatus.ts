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

/**
 * Decide what to actually write, given where the ticket is now. Null means
 * leave it alone.
 *
 * Sync owns exactly one claim: "every linked PR is merged, so this is done."
 * It may make that claim and it may retract it. It has no business deciding
 * between Draft and Assigned — a ticket is Assigned when someone picks it up,
 * which is normally true long before a PR exists. Demoting those back to Draft
 * on every sweep is how this fought its users on the first day.
 *
 * So a computed Draft only ever gets written to undo a previous Completed.
 */
export function decideTicketWrite(current: string | undefined, computed: TicketStatus): TicketStatus | null {
  if (computed === current) return null;
  if (computed === "Draft" && current !== "Completed") return null;
  return computed;
}

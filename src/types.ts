/**
 * The internal shape everything downstream works with.
 *
 * Both a webhook payload and a REST response normalize into this, which is what
 * lets the event path and the reconcile path share one pipeline — and what makes
 * a PR syncable locally without a webhook to fire it.
 */
export interface PullRequest {
  /** "owner/name" */
  repo: string;
  number: number;
  title: string;
  /** html_url — the identity of the Notion page */
  url: string;
  body: string;
  /** head ref, e.g. "feat/UX-12-tidy-tokens" */
  branch: string;
  author: string;
  reviewers: string[];
  draft: boolean;
  merged: boolean;
  openedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

/** GitHub's aggregate review verdict. Null when nobody has reviewed. */
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

/** A ticket reference parsed out of a PR — either a key number or a pasted page id. */
export type TicketRef = { kind: "key"; value: number } | { kind: "page"; value: string };

/** Just enough of a PR for the ticket status rule. */
export interface PrOutcome {
  merged: boolean;
  closed: boolean;
}

export type NotionBlock = Record<string, unknown>;

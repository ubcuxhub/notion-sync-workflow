import type { PullRequest } from "../types.js";

/**
 * The subset of GitHub's PR shape sync reads.
 *
 * Webhook payloads and REST responses agree on all of these fields, which is
 * what lets one normalizer serve both paths.
 */
interface RawPullRequest {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  created_at: string;
  closed_at?: string | null;
  updated_at: string;
  head?: { ref?: string } | null;
  user?: { login?: string } | null;
  requested_reviewers?: ({ login?: string } | null)[] | null;
}

export function normalizePr(raw: RawPullRequest, repo: string): PullRequest {
  return {
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    body: raw.body ?? "",
    branch: raw.head?.ref ?? "",
    author: raw.user?.login ?? "",
    reviewers: (raw.requested_reviewers ?? []).map((r) => r?.login).filter((l): l is string => Boolean(l)),
    draft: raw.draft ?? false,
    // `merged` is absent from list responses, where merged_at is the signal.
    merged: raw.merged ?? Boolean(raw.merged_at),
    openedAt: raw.created_at,
    mergedAt: raw.merged_at ?? null,
    closedAt: raw.closed_at ?? null,
    updatedAt: raw.updated_at,
  };
}

import type { PullRequest } from "../src/types.js";

/** A merged-looking PR by default; override whatever the case under test needs. */
export function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: "acme/ux-hub-web",
    number: 42,
    title: "Tidy the tokens",
    url: "https://github.com/acme/ux-hub-web/pull/42",
    body: "",
    branch: "tidy-tokens",
    author: "johnny-581",
    reviewers: [],
    draft: false,
    merged: false,
    openedAt: "2026-08-01T10:00:00Z",
    mergedAt: null,
    closedAt: null,
    updatedAt: "2026-08-02T10:00:00Z",
    ...overrides,
  };
}

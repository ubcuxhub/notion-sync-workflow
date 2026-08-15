import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { normalizePr } from "./normalize.js";
import type { PullRequest, ReviewDecision } from "../types.js";

export function octokit(token: string): Octokit {
  if (!token) throw new Error("GITHUB_TOKEN is empty — needed to read PRs");
  return new Octokit({ auth: token });
}

/**
 * The PR that triggered this workflow run.
 *
 * Returns undefined for events without a pull_request (a mis-wired trigger), so
 * the caller can no-op rather than crash a run that was never meant to sync.
 */
export function prFromEvent(): PullRequest | undefined {
  const path = process.env["GITHUB_EVENT_PATH"];
  if (!path) return undefined;

  const event = JSON.parse(readFileSync(path, "utf8")) as {
    pull_request?: Parameters<typeof normalizePr>[0];
    repository?: { full_name?: string };
  };
  if (!event.pull_request) return undefined;

  const repo = event.repository?.full_name ?? process.env["GITHUB_REPOSITORY"] ?? "";
  return normalizePr(event.pull_request, repo);
}

export async function fetchPr(gh: Octokit, repo: string, number: number): Promise<PullRequest> {
  const [owner, name] = splitRepo(repo);
  const { data } = await gh.pulls.get({ owner, repo: name, pull_number: number });
  return normalizePr(data, repo);
}

/**
 * PRs worth re-syncing for a repo: everything updated since `since`, plus every
 * open PR regardless of age. The second half matters because a PR nobody has
 * touched in months is exactly the kind that drifts unnoticed.
 */
export async function fetchPrsForReconcile(gh: Octokit, repo: string, since: Date): Promise<PullRequest[]> {
  const [owner, name] = splitRepo(repo);
  const found = new Map<number, PullRequest>();

  for await (const page of gh.paginate.iterator(gh.pulls.list, {
    owner,
    repo: name,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  })) {
    let exhausted = false;
    for (const raw of page.data) {
      const pr = normalizePr(raw, repo);
      const stale = new Date(pr.updatedAt) < since;
      if (stale && pr.closedAt) {
        // Sorted by updated desc, so everything past here is older and closed.
        exhausted = true;
        continue;
      }
      found.set(pr.number, pr);
    }
    if (exhausted) break;
  }

  return [...found.values()];
}

/**
 * GitHub's aggregate review verdict, which the webhook payload does not carry.
 * One GraphQL field is cheaper and more truthful than replaying every review
 * event and trying to reconstruct the outcome.
 */
export async function fetchReviewDecision(
  gh: Octokit,
  repo: string,
  number: number,
  onError?: (message: string) => void,
): Promise<ReviewDecision> {
  const [owner, name] = splitRepo(repo);
  try {
    const res = await gh.graphql<{ repository?: { pullRequest?: { reviewDecision: ReviewDecision } } }>(
      `query($owner: String!, $name: String!, $number: Int!) {
         repository(owner: $owner, name: $name) {
           pullRequest(number: $number) { reviewDecision }
         }
       }`,
      { owner, name, number },
    );
    return res.repository?.pullRequest?.reviewDecision ?? null;
  } catch (err) {
    // Degrading to "Open" is the right behaviour — a review lookup should not
    // fail a sync — but it must not be silent: a token that loses GraphQL access
    // would otherwise park every open PR in "Open" and look entirely normal.
    onError?.(`review decision lookup failed for ${repo}#${number}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function splitRepo(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Expected "owner/name", got "${repo}"`);
  return [owner, name];
}

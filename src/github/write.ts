import type { Octokit } from "@octokit/rest";
import { splitRepo } from "./client.js";

/**
 * The only writes sync makes to GitHub — each driven by a human edit in Notion.
 *
 * Failures are returned, not thrown. The usual one is a 422 for a reviewer who
 * is not a collaborator, is the PR author, or is a typo in a Notion
 * multi-select; that belongs on the row where the person made it, not as a
 * failed run that hides every other PR's sync.
 */

export interface WriteResult {
  ok: boolean;
  error?: string;
}

export interface WriteContext {
  gh: Octokit;
  dryRun: boolean;
  log: (message: string) => void;
}

export async function updateBody(w: WriteContext, repo: string, number: number, body: string): Promise<WriteResult> {
  const [owner, name] = splitRepo(repo);
  return attempt(w, `update description of ${repo}#${number}`, () =>
    w.gh.pulls.update({ owner, repo: name, pull_number: number, body }),
  );
}

export async function requestReviewer(w: WriteContext, repo: string, number: number, login: string): Promise<WriteResult> {
  const [owner, name] = splitRepo(repo);
  return attempt(w, `request ${login} on ${repo}#${number}`, () =>
    w.gh.pulls.requestReviewers({ owner, repo: name, pull_number: number, reviewers: [login] }),
  );
}

export async function removeReviewer(w: WriteContext, repo: string, number: number, login: string): Promise<WriteResult> {
  const [owner, name] = splitRepo(repo);
  return attempt(w, `remove ${login} from ${repo}#${number}`, () =>
    w.gh.pulls.removeRequestedReviewers({ owner, repo: name, pull_number: number, reviewers: [login] }),
  );
}

async function attempt(w: WriteContext, what: string, call: () => Promise<unknown>): Promise<WriteResult> {
  if (w.dryRun) {
    w.log(`  would ${what}`);
    return { ok: true };
  }
  try {
    await call();
    w.log(`  ${what}`);
    return { ok: true };
  } catch (err) {
    const error = `could not ${what}: ${err instanceof Error ? err.message : String(err)}`;
    w.log(`  ${error}`);
    return { ok: false, error };
  }
}

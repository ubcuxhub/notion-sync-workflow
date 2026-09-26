/**
 * Three-way merge for a set-valued field that both Notion and GitHub can edit.
 *
 * A single snapshot cannot tell "a human added a reviewer in Notion" from
 * "GitHub dropped a reviewer and Notion is stale" — they look identical. The
 * shadow breaks the tie: it is what GitHub said the last time sync wrote the
 * row, so anything Notion holds beyond it is a human edit, and anything GitHub
 * holds beyond it is a GitHub change.
 *
 * Merging element by element rather than whole values means there is no
 * conflict case: a reviewer added in Notion and a different one requested on
 * GitHub in the same window both survive.
 */

export interface MergeResult {
  /** What GitHub should hold once the Notion edit is applied. */
  desired: string[];
  /** True when `desired` differs from GitHub — there is a Notion edit to push. */
  pending: boolean;
}

export function mergeSet(shadow: string[] | null, notion: string[], github: string[]): MergeResult {
  // No shadow means the row predates write-back (or is brand new). There is no
  // baseline to diff against, so GitHub wins — pushing Notion's value would
  // replay every stale row as if a human had just edited it.
  if (shadow === null) return { desired: sorted(github), pending: false };

  const base = new Set(shadow);
  const now = new Set(notion);
  const added = notion.filter((v) => !base.has(v));
  const removed = new Set(shadow.filter((v) => !now.has(v)));

  const desired = sorted([...new Set([...github, ...added])].filter((v) => !removed.has(v)));
  return { desired, pending: !sameSet(desired, github) };
}

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

/** Empty text is "never written", distinct from "[]", which is a known-empty value. */
export function parseShadow(text: string): string[] | null {
  if (!text.trim()) return null;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    // A shadow someone hand-edited into nonsense is treated as absent: GitHub
    // wins once and the shadow is rewritten cleanly.
    return null;
  }
}

export function serializeShadow(values: string[]): string {
  return JSON.stringify(sorted(values));
}

function sorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

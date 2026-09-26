import type { PullRequest, TicketRef } from "../types.js";
import { hasTicketRegion } from "./ticketRegion.js";

/**
 * Find the tickets a PR claims to serve.
 *
 * Three levels, checked in order — the first that yields anything wins, and
 * every reference at that level is collected (a PR may serve several tickets):
 *
 *   1. body directive  — "Ticket: UX-12", "Closes UX-12", or a pasted Notion URL
 *   2. branch name     — "feat/UX-12/tokens", "ux-12-tokens"
 *   3. title prefix    — "[UX-12] Tidy tokens"
 *
 * The levels are ordered by how deliberate they are. A branch name is a decent
 * signal but people rename branches and reuse them; an explicit line in the body
 * is someone saying what they mean, so it beats an incidental match elsewhere.
 */
export function resolveTicketRefs(pr: PullRequest, prefix: string): TicketRef[] {
  // The region's markers are comments, so check for them before stripping. Once
  // Notion has written the region, the body is authoritative even when empty —
  // otherwise unlinking a ticket in Notion would be undone by a key in the branch.
  const regionPresent = hasTicketRegion(pr.body);

  // PR templates ship commented-out examples ("<!-- Ticket: UX-123 -->"). Those
  // are instructions to the author, not claims by this PR.
  const body = pr.body.replace(/<!--[\s\S]*?-->/g, "");

  const fromBody = [...directiveRefs(body, prefix), ...notionUrlRefs(body)];
  if (fromBody.length || regionPresent) return dedupe(fromBody);

  const fromBranch = keyRefs(pr.branch, prefix);
  if (fromBranch.length) return dedupe(fromBranch);

  return dedupe(titlePrefixRefs(pr.title, prefix));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Ticket: UX-12", "Closes UX-12", "Fixes UX-12, UX-13" */
function directiveRefs(body: string, prefix: string): TicketRef[] {
  const p = escapeRegex(prefix);
  const re = new RegExp(`\\b(?:tickets?|closes?|closed|fixe?s?|fixed|resolves?|resolved)\\b[:\\s]+((?:${p}-\\d+[\\s,]*)+)`, "gi");
  const refs: TicketRef[] = [];
  for (const match of body.matchAll(re)) {
    refs.push(...keyRefs(match[1] ?? "", prefix));
  }
  return refs;
}

/** Any UX-123 token in the given text. */
function keyRefs(text: string, prefix: string): TicketRef[] {
  const re = new RegExp(`\\b${escapeRegex(prefix)}-(\\d+)\\b`, "gi");
  const refs: TicketRef[] = [];
  for (const match of text.matchAll(re)) {
    refs.push({ kind: "key", value: Number(match[1]) });
  }
  return refs;
}

/** Only when the key leads the title: "[UX-12] …" or "UX-12: …". */
function titlePrefixRefs(title: string, prefix: string): TicketRef[] {
  const re = new RegExp(`^\\s*[\\[(]?\\s*((?:${escapeRegex(prefix)}-\\d+[\\s,]*)+)[\\])]?\\s*[:\\-—]?`, "i");
  const match = re.exec(title);
  return match ? keyRefs(match[1] ?? "", prefix) : [];
}

/**
 * A pasted Notion page URL, e.g.
 *   https://www.notion.so/team/Fix-the-thing-1f2e3d4c5b6a7890abcdef1234567890
 *   https://notion.so/1f2e3d4c-5b6a-7890-abcd-ef1234567890
 *
 * The id is taken at face value here; whether it is actually a ticket page gets
 * checked when it is resolved against the Tickets data source.
 */
function notionUrlRefs(body: string): TicketRef[] {
  const re = /https?:\/\/(?:www\.)?notion\.(?:so|site)\/[^\s)>\]]*?([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  const refs: TicketRef[] = [];
  for (const match of body.matchAll(re)) {
    const raw = match[1];
    if (raw) refs.push({ kind: "page", value: normalizeId(raw) });
  }
  return refs;
}

/** Notion accepts both, but we compare ids as strings, so pick one form. */
export function normalizeId(id: string): string {
  const bare = id.replace(/-/g, "").toLowerCase();
  if (bare.length !== 32) return id.toLowerCase();
  return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
}

function dedupe(refs: TicketRef[]): TicketRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.kind}:${r.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The machine-owned region of a PR description that holds tickets linked from
 * Notion.
 *
 *   <!-- notion-sync:tickets -->
 *   Ticket: UX-3, UX-7
 *   <!-- /notion-sync:tickets -->
 *
 * Writing into a marked region, rather than appending a bare line, is what
 * makes relinking and unlinking clean: the region is replaced wholesale and
 * nothing else in the description is touched. The markers are HTML comments,
 * so they vanish from the rendered PR and from the Notion page body, while the
 * line between them is an ordinary directive the ticket parser already reads.
 */

const OPEN = "<!-- notion-sync:tickets -->";
const CLOSE = "<!-- /notion-sync:tickets -->";
const REGION_RE = /<!-- notion-sync:tickets -->[\s\S]*?<!-- \/notion-sync:tickets -->/;

export function hasTicketRegion(body: string): boolean {
  return REGION_RE.test(body);
}

/**
 * Insert or replace the region. An empty key list still writes the region —
 * `Ticket: none` — because its presence is what stops the parser falling back
 * to a key in the branch name or title, which would undo the unlink.
 */
export function writeTicketRegion(body: string, keys: string[]): string {
  const line = keys.length ? `Ticket: ${keys.join(", ")}` : "Ticket: none";
  const region = `${OPEN}\n${line}\n${CLOSE}`;
  if (hasTicketRegion(body)) return body.replace(REGION_RE, region);
  const rest = body.trimEnd();
  return rest ? `${rest}\n\n${region}\n` : `${region}\n`;
}

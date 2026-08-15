/**
 * The PR description, written into the Notion page body as ordinary blocks.
 *
 * GitHub wins: when the PR body changes, sync replaces the page body wholesale.
 * Human edits are not preserved — the page is a mirror. Distinguishing human
 * blocks from synced ones would cost an extra read, an extra stored hash, and a
 * rule nobody could reason about from inside Notion.
 */

import { createHash } from "node:crypto";
import { chunkBlocks } from "../core/renderBody.js";
import type { NotionBlock } from "../types.js";
import type { NotionClient } from "./client.js";

export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/**
 * Replace a page's blocks with `blocks`.
 *
 * Notion has no "set children" call, so this is a read, N deletes and an append.
 * That cost is why callers gate on the body hash — most events never touch the
 * description, and paying this on every `closed` or `review_requested` event
 * would dominate the rate limit.
 */
export async function replacePageBody(client: NotionClient, pageId: string, blocks: NotionBlock[]): Promise<void> {
  const existing = await listChildren(client, pageId);
  for (const child of existing) {
    await client.request("DELETE", `/blocks/${child}`);
  }
  await appendBlocks(client, pageId, blocks);
}

export async function appendBlocks(client: NotionClient, pageId: string, blocks: NotionBlock[]): Promise<void> {
  for (const chunk of chunkBlocks(blocks)) {
    await client.request("PATCH", `/blocks/${pageId}/children`, { children: chunk });
  }
}

async function listChildren(client: NotionClient, pageId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    const page = await client.request<{ results: { id: string }[]; has_more: boolean; next_cursor: string | null }>(
      "GET",
      `/blocks/${pageId}/children?${qs}`,
    );
    ids.push(...page.results.map((r) => r.id));
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return ids;
}

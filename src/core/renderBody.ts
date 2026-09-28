import { markdownToBlocks } from "@tryfabric/martian";
import type { NotionBlock } from "../types.js";

/** Notion accepts at most 100 children per create/append call. */
export const MAX_BLOCKS_PER_REQUEST = 100;

/**
 * Convert a PR description to Notion blocks.
 *
 * PR bodies are the messiest input in the system — template comments, images,
 * HTML, task lists, occasionally 40kB of generated changelog. A description that
 * fails to convert must never fail the sync, so anything unexpected degrades to
 * a single plain paragraph rather than throwing.
 */
export function renderBody(markdown: string): NotionBlock[] {
  const cleaned = clean(markdown);
  if (!cleaned) return [];

  try {
    return markdownToBlocks(cleaned, {
      // Truncate over-long rich text rather than rejecting the whole document.
      notionLimits: { truncate: true },
      // A PR body can carry relative or private image URLs Notion cannot fetch.
      strictImageUrls: true,
    }) as NotionBlock[];
  } catch {
    return [paragraph(cleaned.slice(0, 1900))];
  }
}

/**
 * The page body: a notice that the description is a mirror, then the
 * description itself. Without the notice, an edit to the body looks like it
 * stuck until the next GitHub change silently wipes it.
 */
export function renderPageBody(markdown: string, prUrl: string): NotionBlock[] {
  return [mirrorNotice(prUrl), ...renderBody(markdown)];
}

export function mirrorNotice(prUrl: string): NotionBlock {
  return {
    object: "block",
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "🔁" },
      color: "gray_background",
      rich_text: [
        { type: "text", text: { content: "Mirrored from GitHub — edits here are overwritten. " } },
        { type: "text", text: { content: "Edit the description on GitHub ↗", link: { url: prUrl } } },
      ],
    },
  };
}

function clean(markdown: string): string {
  return markdown
    // PR templates are mostly HTML comments; they carry no meaning for a reader.
    .replace(/<!--[\s\S]*?-->/g, "")
    // Images usually point at private user-content URLs Notion cannot resolve.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `[image: ${alt}]` : ""))
    .replace(/\r\n/g, "\n")
    .trim();
}

export function paragraph(text: string): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: text ? [{ type: "text", text: { content: text } }] : [] },
  };
}

/** Split into ≤100-block chunks: the first goes in the create call, the rest are appended. */
export function chunkBlocks(blocks: NotionBlock[]): NotionBlock[][] {
  const chunks: NotionBlock[][] = [];
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
    chunks.push(blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST));
  }
  return chunks;
}

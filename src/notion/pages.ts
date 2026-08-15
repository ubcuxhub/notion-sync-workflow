/** Helpers for reading and building Notion property values. */

import type { NotionBlock } from "../types.js";

export interface NotionPage {
  id: string;
  properties: Record<string, PropertyValue>;
}

export interface PropertyValue {
  type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  url?: string | null;
  number?: number | null;
  checkbox?: boolean;
  select?: { name: string } | null;
  multi_select?: { name: string }[];
  status?: { name: string } | null;
  date?: { start: string } | null;
  relation?: { id: string }[];
  unique_id?: { prefix: string | null; number: number };
}

// ---------- reads ----------

export function readText(page: NotionPage, prop: string): string {
  const p = page.properties[prop];
  const parts = p?.rich_text ?? p?.title ?? [];
  return parts.map((t) => t.plain_text).join("");
}

export function readSelect(page: NotionPage, prop: string): string | undefined {
  return page.properties[prop]?.select?.name ?? page.properties[prop]?.status?.name;
}

export function readCheckbox(page: NotionPage, prop: string): boolean {
  return page.properties[prop]?.checkbox ?? false;
}

export function readRelationIds(page: NotionPage, prop: string): string[] {
  return (page.properties[prop]?.relation ?? []).map((r) => r.id);
}

// ---------- writes ----------

export const title = (text: string) => ({ title: [{ type: "text", text: { content: truncate(text, 2000) } }] });
export const richText = (text: string) => ({
  rich_text: text ? [{ type: "text", text: { content: truncate(text, 2000) } }] : [],
});
export const url = (value: string) => ({ url: value || null });
export const number = (value: number) => ({ number: value });
export const select = (name: string | null) => ({ select: name ? { name } : null });
export const status = (name: string) => ({ status: { name } });
export const multiSelect = (names: string[]) => ({
  // Notion rejects option names containing commas.
  multi_select: names.map((name) => ({ name: name.replace(/,/g, " ") })),
});
export const date = (iso: string | null) => ({ date: iso ? { start: iso } : null });
export const relation = (ids: string[]) => ({ relation: ids.map((id) => ({ id })) });

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface PageChildren {
  results: { id: string }[];
  has_more: boolean;
  next_cursor: string | null;
}

export type { NotionBlock };

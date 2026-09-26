import { hashBody, replacePageBody, appendBlocks } from "./body.js";
import { chunkBlocks, renderBody } from "../core/renderBody.js";
import type { PrState, LinkStatus } from "./schema.js";
import { PR_PROPS } from "./schema.js";
import * as p from "./pages.js";
import type { NotionPage } from "./pages.js";
import type { PullRequest } from "../types.js";
import type { SyncContext } from "./context.js";
import { parseShadow, sameSet, serializeShadow } from "../core/mergeField.js";
import { normalizeId } from "../core/resolveTicketKeys.js";

export interface UpsertFields {
  state: PrState;
  ticketIds: string[];
  linkStatus: LinkStatus;
  reviewers: string[];
  /** What GitHub holds for each write-back field — see core/mergeField.ts. */
  ticketShadow: string[];
  reviewersShadow: string[];
  /** Why the last push to GitHub failed; empty clears it. */
  syncError: string;
}

export interface UpsertResult {
  pageId: string | undefined;
  created: boolean;
  /** False when every property but `Synced at` already held these values. */
  changed: boolean;
  bodyRewritten: boolean;
}

/**
 * Create or update the Notion page for a PR.
 *
 * `URL` is the identity. The caller looks the page up with `findPrPage` — one
 * extra read per event, which buys idempotency: a replayed event, a reconcile
 * sweep and a live webhook all converge on the same page instead of racing to
 * create duplicates. It also has to read the page first anyway, to merge the
 * fields a human may have edited.
 */
export async function upsertPr(
  ctx: SyncContext,
  existing: NotionPage | undefined,
  pr: PullRequest,
  fields: UpsertFields,
): Promise<UpsertResult> {
  const bodyHash = hashBody(pr.body);
  const bodyChanged = !existing || p.readText(existing, PR_PROPS.bodyHash) !== bodyHash;

  const properties: Record<string, unknown> = {
    [PR_PROPS.name]: p.title(`#${pr.number} · ${pr.title}`),
    [PR_PROPS.url]: p.url(pr.url),
    [PR_PROPS.state]: p.select(fields.state),
    [PR_PROPS.repo]: p.select(pr.repo),
    [PR_PROPS.number]: p.number(pr.number),
    [PR_PROPS.author]: p.select(pr.author),
    [PR_PROPS.reviewers]: p.multiSelect(fields.reviewers),
    [PR_PROPS.opened]: p.date(pr.openedAt),
    [PR_PROPS.merged]: p.date(pr.mergedAt),
    [PR_PROPS.closed]: p.date(pr.closedAt),
    [PR_PROPS.lastActivity]: p.date(pr.updatedAt),
    [PR_PROPS.ticket]: p.relation(fields.ticketIds),
    [PR_PROPS.linkStatus]: p.select(fields.linkStatus),
    [PR_PROPS.bodyHash]: p.richText(bodyHash),
    [PR_PROPS.ticketShadow]: p.richText(serializeShadow(fields.ticketShadow)),
    [PR_PROPS.reviewersShadow]: p.richText(serializeShadow(fields.reviewersShadow)),
    [PR_PROPS.syncError]: p.richText(fields.syncError),
  };
  const changed = !existing || p.differs(existing, properties);
  properties[PR_PROPS.syncedAt] = p.date(new Date().toISOString());

  if (ctx.dryRun) {
    return { pageId: existing?.id, created: !existing, changed, bodyRewritten: bodyChanged };
  }

  if (existing) {
    await ctx.client.request("PATCH", `/pages/${existing.id}`, { properties });
    if (bodyChanged) await replacePageBody(ctx.client, existing.id, renderBody(pr.body));
    return { pageId: existing.id, created: false, changed, bodyRewritten: bodyChanged };
  }

  const blocks = renderBody(pr.body);
  const [first = [], ...rest] = chunkBlocks(blocks);
  const page = await ctx.client.request<{ id: string }>("POST", "/pages", {
    parent: { type: "data_source_id", data_source_id: ctx.prDs },
    properties,
    children: first,
  });
  for (const chunk of rest) {
    await appendBlocks(ctx.client, page.id, chunk);
  }
  return { pageId: page.id, created: true, changed: true, bodyRewritten: blocks.length > 0 };
}

export async function findPrPage(ctx: SyncContext, prUrl: string): Promise<NotionPage | undefined> {
  return ctx.client.queryOne<NotionPage>(ctx.prDs, {
    property: PR_PROPS.url,
    url: { equals: prUrl },
  });
}

/** Every PR page whose `Synced at` is older than `before` — the reconcile staleness sweep. */
export async function findStalePrPages(ctx: SyncContext, before: Date): Promise<NotionPage[]> {
  return ctx.client.queryAll<NotionPage>(ctx.prDs, {
    filter: {
      or: [
        { property: PR_PROPS.syncedAt, date: { before: before.toISOString() } },
        { property: PR_PROPS.syncedAt, date: { is_empty: true } },
      ],
    },
  });
}

/**
 * PR rows with a Notion edit waiting to go to GitHub: edited since `since`, and
 * holding a Ticket or Reviewers value that differs from its shadow.
 *
 * The shadow check is what lets the poller ignore its own writes. Every sync
 * bumps `last_edited_time`, so the time filter alone would return every row sync
 * touched; a row whose fields match their shadows has nothing to push. Rows
 * with no shadow yet are skipped — they predate write-back and there is no
 * baseline to say what the human changed.
 */
export async function findPendingPrPages(ctx: SyncContext, since: Date): Promise<NotionPage[]> {
  const pages = await ctx.client.queryAll<NotionPage>(ctx.prDs, {
    filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: since.toISOString() } },
  });
  return pages.filter((page) => {
    const tickets = readTicketIds(page);
    const reviewers = p.readMultiSelect(page, PR_PROPS.reviewers);
    const ticketShadow = parseShadow(p.readText(page, PR_PROPS.ticketShadow));
    const reviewersShadow = parseShadow(p.readText(page, PR_PROPS.reviewersShadow));
    return (
      (ticketShadow !== null && !sameSet(tickets, ticketShadow)) ||
      (reviewersShadow !== null && !sameSet(reviewers, reviewersShadow))
    );
  });
}

/** Relation ids in the one form ticket ids are compared in. */
export function readTicketIds(page: NotionPage): string[] {
  return p.readRelationIds(page, PR_PROPS.ticket).map(normalizeId);
}

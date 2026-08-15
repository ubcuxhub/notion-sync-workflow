import { hashBody, replacePageBody, appendBlocks } from "./body.js";
import { chunkBlocks, renderBody } from "../core/renderBody.js";
import type { PrState, LinkStatus } from "./schema.js";
import { PR_PROPS } from "./schema.js";
import * as p from "./pages.js";
import type { NotionPage } from "./pages.js";
import type { PullRequest } from "../types.js";
import type { SyncContext } from "./context.js";

export interface UpsertResult {
  pageId: string | undefined;
  created: boolean;
  /** Tickets the page was linked to *before* this sync — they may need recomputing too. */
  previousTicketIds: string[];
  bodyRewritten: boolean;
}

/**
 * Create or update the Notion page for a PR.
 *
 * `URL` is the identity. Querying by it costs one extra read per event, which
 * buys idempotency: a replayed event, a reconcile sweep and a live webhook all
 * converge on the same page instead of racing to create duplicates.
 */
export async function upsertPr(
  ctx: SyncContext,
  pr: PullRequest,
  state: PrState,
  ticketIds: string[],
  linkStatus: LinkStatus,
): Promise<UpsertResult> {
  const existing = await findPrPage(ctx, pr.url);

  const bodyHash = hashBody(pr.body);
  // Reading the existing relation before overwriting it is what lets a ticket
  // that was just unlinked get recomputed — otherwise it would keep whatever
  // status it had when the PR was still attached.
  const previousTicketIds = existing ? p.readRelationIds(existing, PR_PROPS.ticket) : [];
  const bodyChanged = !existing || p.readText(existing, PR_PROPS.bodyHash) !== bodyHash;

  const properties = {
    [PR_PROPS.name]: p.title(`#${pr.number} · ${pr.title}`),
    [PR_PROPS.url]: p.url(pr.url),
    [PR_PROPS.state]: p.select(state),
    [PR_PROPS.repo]: p.select(pr.repo),
    [PR_PROPS.number]: p.number(pr.number),
    [PR_PROPS.author]: p.select(pr.author),
    [PR_PROPS.reviewers]: p.multiSelect(pr.reviewers),
    [PR_PROPS.opened]: p.date(pr.openedAt),
    [PR_PROPS.merged]: p.date(pr.mergedAt),
    [PR_PROPS.closed]: p.date(pr.closedAt),
    [PR_PROPS.lastActivity]: p.date(pr.updatedAt),
    [PR_PROPS.ticket]: p.relation(ticketIds),
    [PR_PROPS.linkStatus]: p.select(linkStatus),
    [PR_PROPS.bodyHash]: p.richText(bodyHash),
    [PR_PROPS.syncedAt]: p.date(new Date().toISOString()),
  };

  if (ctx.dryRun) {
    return { pageId: existing?.id, created: !existing, previousTicketIds, bodyRewritten: bodyChanged };
  }

  if (existing) {
    await ctx.client.request("PATCH", `/pages/${existing.id}`, { properties });
    if (bodyChanged) await replacePageBody(ctx.client, existing.id, renderBody(pr.body));
    return { pageId: existing.id, created: false, previousTicketIds, bodyRewritten: bodyChanged };
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
  return { pageId: page.id, created: true, previousTicketIds, bodyRewritten: blocks.length > 0 };
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

import { computeTicketStatus, decideTicketWrite } from "../core/computeTicketStatus.js";
import type { PrOutcome, TicketRef } from "../types.js";
import type { SyncContext } from "./context.js";
import * as p from "./pages.js";
import type { NotionPage } from "./pages.js";
import { PR_PROPS, TICKET_PROPS, type TicketStatus } from "./schema.js";

/**
 * Turn parsed ticket references into Notion page ids.
 *
 * A reference that resolves to nothing is dropped rather than raised: tickets
 * are often created after the PR that mentions them, and a typo in a PR body
 * must never fail a sync. The PR lands in the unlinked triage view instead.
 */
export async function resolveRefs(ctx: SyncContext, refs: TicketRef[]): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) {
    const id = ref.kind === "key" ? await byKey(ctx, ref.value) : await byPageId(ctx, ref.value);
    if (id) ids.push(id);
    else ctx.log(`  unresolved ticket reference: ${ref.kind}=${ref.value}`);
  }
  return [...new Set(ids)];
}

async function byKey(ctx: SyncContext, key: number): Promise<string | undefined> {
  const page = await ctx.client.queryOne<NotionPage>(ctx.ticketsDs, {
    property: TICKET_PROPS.id,
    unique_id: { equals: key },
  });
  return page?.id;
}

/**
 * A pasted Notion URL could point at any page in the workspace, so confirm it
 * actually lives in the Tickets database before relating a PR to it.
 */
async function byPageId(ctx: SyncContext, pageId: string): Promise<string | undefined> {
  try {
    const page = await ctx.client.request<{ id: string; parent: { data_source_id?: string } }>(
      "GET",
      `/pages/${pageId}`,
    );
    if (page.parent?.data_source_id !== ctx.ticketsDs) {
      ctx.log(`  ${pageId} is not a ticket page — ignoring`);
      return undefined;
    }
    return page.id;
  } catch {
    return undefined;
  }
}

/**
 * Ticket page ids → their keys ("UX-12"), for writing into a PR description.
 *
 * Keys rather than Notion URLs because the description is read by people on
 * GitHub, and a key is what they would have typed. A page with no readable key
 * is left out and logged; the caller notices it missing from what GitHub holds.
 */
export async function ticketKeys(ctx: SyncContext, pageIds: string[]): Promise<string[]> {
  const keys: string[] = [];
  for (const id of pageIds) {
    try {
      const page = await ctx.client.request<NotionPage>("GET", `/pages/${id}`);
      const uid = page.properties[TICKET_PROPS.id]?.unique_id;
      if (uid) keys.push(`${uid.prefix ?? ctx.ticketKeyPrefix}-${uid.number}`);
      else ctx.log(`  ticket ${id} has no ${TICKET_PROPS.id} — cannot write it to GitHub`);
    } catch (err) {
      ctx.log(`  could not read ticket ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return keys;
}

export interface RecomputeResult {
  ticketId: string;
  from: string | undefined;
  to: TicketStatus;
  changed: boolean;
  locked: boolean;
}

/**
 * Recompute one ticket's status from the PRs currently related to it.
 *
 * The PR set is read from Notion rather than taken from the event, because a
 * ticket's PRs may live in repos this run knows nothing about. One
 * `relation contains` query gets them all — reading each related page instead
 * would cost a request per PR.
 */
export async function recomputeTicket(ctx: SyncContext, ticketId: string): Promise<RecomputeResult> {
  const ticket = await ctx.client.request<NotionPage>("GET", `/pages/${ticketId}`);
  const current = p.readSelect(ticket, TICKET_PROPS.status);

  if (p.readCheckbox(ticket, TICKET_PROPS.statusLocked)) {
    return { ticketId, from: current, to: (current as TicketStatus) ?? "Draft", changed: false, locked: true };
  }

  const prPages = await ctx.client.queryAll<NotionPage>(ctx.prDs, {
    filter: { property: PR_PROPS.ticket, relation: { contains: ticketId } },
  });
  const computed = computeTicketStatus(prPages.map(toOutcome));
  const next = decideTicketWrite(current, computed);

  if (next === null) {
    return { ticketId, from: current, to: computed, changed: false, locked: false };
  }

  if (ctx.dryRun) {
    ctx.log(`  would set ticket ${ticketId}: ${current ?? "—"} → ${next}`);
  } else {
    await ctx.client.request("PATCH", `/pages/${ticketId}`, {
      properties: {
        [TICKET_PROPS.status]: p.status(next),
        [TICKET_PROPS.autoUpdatedAt]: p.date(new Date().toISOString()),
      },
    });
  }
  return { ticketId, from: current, to: next, changed: true, locked: false };
}

/** The State select is the source of truth in Notion, so no extra reads are needed. */
function toOutcome(page: NotionPage): PrOutcome {
  const state = p.readSelect(page, PR_PROPS.state);
  return { merged: state === "Merged", closed: state === "Merged" || state === "Closed" };
}

/** Tickets reconcile should revisit: anything not already Completed and not locked. */
export async function findUnfinishedTickets(ctx: SyncContext): Promise<string[]> {
  const pages = await ctx.client.queryAll<NotionPage>(ctx.ticketsDs, {
    filter: {
      and: [
        { property: TICKET_PROPS.status, status: { does_not_equal: "Completed" } },
        { property: TICKET_PROPS.statusLocked, checkbox: { equals: false } },
      ],
    },
  });
  return pages.map((page) => page.id);
}

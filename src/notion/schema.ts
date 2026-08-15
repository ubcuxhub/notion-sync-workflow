/**
 * The schema sync depends on, and a verifier for it.
 *
 * Notion returns `validation_error` with no indication of which property is
 * wrong, so a missing or mistyped property surfaces as an opaque 400 halfway
 * through a run. Checking the schema up front turns that into one readable
 * message. Every mode runs this before it writes anything.
 */

import type { NotionClient } from "./client.js";

/** Property names are the contract with Notion — they are read by name, not id. */
export const PR_PROPS = {
  name: "Name",
  url: "URL",
  state: "State",
  repo: "Repo",
  number: "Number",
  author: "Author",
  reviewers: "Reviewers",
  opened: "Opened",
  merged: "Merged",
  closed: "Closed",
  lastActivity: "Last activity",
  ticket: "Ticket",
  linkStatus: "Link status",
  bodyHash: "Body hash",
  syncedAt: "Synced at",
} as const;

export const TICKET_PROPS = {
  name: "Name",
  id: "ID",
  status: "Status",
  prs: "PRs",
  statusLocked: "Status locked",
  autoUpdatedAt: "Auto-updated at",
} as const;

export const PR_STATES = [
  "Draft",
  "Open",
  "In review",
  "Changes requested",
  "Approved",
  "Merged",
  "Closed",
] as const;
export type PrState = (typeof PR_STATES)[number];

export const TICKET_STATUSES = ["Draft", "Assigned", "Completed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const LINK_STATUSES = ["linked", "unlinked"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

const PR_EXPECTED: Record<string, string> = {
  [PR_PROPS.name]: "title",
  [PR_PROPS.url]: "url",
  [PR_PROPS.state]: "select",
  [PR_PROPS.repo]: "select",
  [PR_PROPS.number]: "number",
  [PR_PROPS.author]: "select",
  [PR_PROPS.reviewers]: "multi_select",
  [PR_PROPS.opened]: "date",
  [PR_PROPS.merged]: "date",
  [PR_PROPS.closed]: "date",
  [PR_PROPS.lastActivity]: "date",
  [PR_PROPS.ticket]: "relation",
  [PR_PROPS.linkStatus]: "select",
  [PR_PROPS.bodyHash]: "rich_text",
  [PR_PROPS.syncedAt]: "date",
};

const TICKET_EXPECTED: Record<string, string> = {
  [TICKET_PROPS.name]: "title",
  [TICKET_PROPS.id]: "unique_id",
  [TICKET_PROPS.status]: "status",
  [TICKET_PROPS.prs]: "relation",
  [TICKET_PROPS.statusLocked]: "checkbox",
  [TICKET_PROPS.autoUpdatedAt]: "date",
};

interface PropertySchema {
  type: string;
  select?: { options: { name: string }[] };
  multi_select?: { options: { name: string }[] };
  status?: { options: { name: string }[] };
  unique_id?: { prefix: string | null };
  relation?: { type?: string; data_source_id?: string; dual_property?: { synced_property_name?: string } };
}

interface DataSource {
  id: string;
  properties: Record<string, PropertySchema>;
}

export interface ResolvedSources {
  ticketsDs: string;
  prDs: string;
}

function checkProperties(label: string, actual: Record<string, PropertySchema>, expected: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, type] of Object.entries(expected)) {
    const prop = actual[name];
    if (!prop) {
      problems.push(`${label}: missing property "${name}" (expected type ${type})`);
    } else if (prop.type !== type) {
      problems.push(`${label}: property "${name}" is ${prop.type}, expected ${type}`);
    }
  }
  return problems;
}

function checkOptions(label: string, prop: PropertySchema | undefined, name: string, wanted: readonly string[]): string[] {
  if (!prop) return [];
  const options = (prop.select ?? prop.status ?? prop.multi_select)?.options ?? [];
  const have = new Set(options.map((o) => o.name));
  const missing = wanted.filter((w) => !have.has(w));
  return missing.length ? [`${label}: "${name}" is missing option(s) ${missing.map((m) => `"${m}"`).join(", ")}`] : [];
}

/**
 * Verify both databases and return their data source ids.
 *
 * Throws with every problem at once rather than the first — a schema built by
 * hand usually has more than one thing off, and one round trip per mistake is
 * a miserable way to find that out.
 */
export async function verifySchema(
  client: NotionClient,
  env: { ticketsDb: string; prDb: string; ticketKeyPrefix: string },
): Promise<ResolvedSources> {
  const ticketsDs = await client.dataSourceId(env.ticketsDb);
  const prDs = await client.dataSourceId(env.prDb);

  const tickets = await client.request<DataSource>("GET", `/data_sources/${ticketsDs}`);
  const prs = await client.request<DataSource>("GET", `/data_sources/${prDs}`);

  const problems = [
    ...checkProperties("Tickets", tickets.properties, TICKET_EXPECTED),
    ...checkProperties("Pull Requests", prs.properties, PR_EXPECTED),
    ...checkOptions("Pull Requests", prs.properties[PR_PROPS.state], PR_PROPS.state, PR_STATES),
    ...checkOptions("Pull Requests", prs.properties[PR_PROPS.linkStatus], PR_PROPS.linkStatus, LINK_STATUSES),
    ...checkOptions("Tickets", tickets.properties[TICKET_PROPS.status], TICKET_PROPS.status, TICKET_STATUSES),
  ];

  const prefix = tickets.properties[TICKET_PROPS.id]?.unique_id?.prefix;
  if (prefix && prefix !== env.ticketKeyPrefix) {
    problems.push(
      `Tickets: "ID" prefix is "${prefix}" but sync.config.json says "${env.ticketKeyPrefix}" — ` +
        `PR bodies referencing ${env.ticketKeyPrefix}-123 would never resolve`,
    );
  }

  // The relation must be two-way, and must point at the other database. A
  // single-property relation would leave Tickets."PRs" permanently empty.
  const rel = prs.properties[PR_PROPS.ticket]?.relation;
  if (rel) {
    if (rel.type !== "dual_property") {
      problems.push(`Pull Requests: "Ticket" relation is ${rel.type}, expected dual_property (two-way)`);
    }
    if (rel.data_source_id && rel.data_source_id !== ticketsDs) {
      problems.push(`Pull Requests: "Ticket" relation points at ${rel.data_source_id}, expected the Tickets data source`);
    }
  }

  if (problems.length) {
    throw new Error(`Notion schema does not match what sync expects:\n  - ${problems.join("\n  - ")}`);
  }

  return { ticketsDs, prDs };
}

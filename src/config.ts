import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

export interface SyncConfig {
  /** Repos the reconcile sweep walks. The event path syncs whatever repo fired it. */
  repos: string[];
  /** Prefix on the Tickets database's ID property, e.g. "UX" for UX-123. */
  ticketKeyPrefix: string;
  /** When false, review substates collapse into "Open" and the GraphQL call is skipped. */
  reviewStates: boolean;
  /** Default lookback for reconcile, in days. */
  reconcileSinceDays: number;
}

export interface Env {
  notionToken: string;
  ticketsDb: string;
  prDb: string;
  githubToken: string;
  dryRun: boolean;
}

export function loadConfig(path = resolve(repoRoot, "sync.config.json")): SyncConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncConfig>;
  return {
    repos: raw.repos ?? [],
    ticketKeyPrefix: raw.ticketKeyPrefix ?? "UX",
    reviewStates: raw.reviewStates ?? true,
    reconcileSinceDays: raw.reconcileSinceDays ?? 14,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadEnv(): Env {
  return {
    notionToken: required("NOTION_TOKEN"),
    ticketsDb: required("NOTION_TICKETS_DB"),
    prDb: required("NOTION_PR_DB"),
    githubToken: process.env["GITHUB_TOKEN"] ?? "",
    dryRun: process.env["DRY_RUN"] === "1" || process.env["DRY_RUN"] === "true",
  };
}

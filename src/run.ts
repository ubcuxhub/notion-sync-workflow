import { loadConfig, loadEnv, type SyncConfig } from "./config.js";
import { octokit } from "./github/client.js";
import { NotionClient } from "./notion/client.js";
import type { SyncContext } from "./notion/context.js";
import { verifySchema } from "./notion/schema.js";
import type { Octokit } from "@octokit/rest";

export interface Runtime {
  ctx: SyncContext;
  gh: Octokit;
  config: SyncConfig;
}

/**
 * Wire everything up: load config, resolve data source ids, and verify the
 * Notion schema before anything writes.
 *
 * The verification is not paranoia — Notion answers a mistyped property with a
 * generic `validation_error`, so without this a renamed column surfaces as an
 * opaque 400 halfway through a sweep.
 */
export async function bootstrap(log: (msg: string) => void): Promise<Runtime> {
  const env = loadEnv();
  const config = loadConfig();
  const client = new NotionClient(env.notionToken);

  const { ticketsDs, prDs } = await verifySchema(client, {
    ticketsDb: env.ticketsDb,
    prDb: env.prDb,
    ticketKeyPrefix: config.ticketKeyPrefix,
  });

  const ctx: SyncContext = {
    client,
    ticketsDs,
    prDs,
    ticketKeyPrefix: config.ticketKeyPrefix,
    dryRun: env.dryRun,
    log,
  };

  return { ctx, gh: octokit(env.githubToken), config };
}

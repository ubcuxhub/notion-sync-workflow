import type { NotionClient } from "./client.js";

/** Everything the Notion layer needs, resolved once per run. */
export interface SyncContext {
  client: NotionClient;
  ticketsDs: string;
  prDs: string;
  ticketKeyPrefix: string;
  dryRun: boolean;
  log: (message: string) => void;
}

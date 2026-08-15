/**
 * Checks the live Notion workspace against the schema sync expects.
 *
 *   npm run verify-schema
 *
 * Reads .env. Exits non-zero with a list of problems if anything is off.
 */

import "dotenv/config";
import { loadConfig, loadEnv } from "../src/config.js";
import { NotionClient } from "../src/notion/client.js";
import { verifySchema } from "../src/notion/schema.js";

async function main() {
  const env = loadEnv();
  const config = loadConfig();
  const client = new NotionClient(env.notionToken);

  const { ticketsDs, prDs } = await verifySchema(client, {
    ticketsDb: env.ticketsDb,
    prDb: env.prDb,
    ticketKeyPrefix: config.ticketKeyPrefix,
  });

  console.log("Notion schema OK");
  console.log(`  Tickets       database ${env.ticketsDb}  ->  data source ${ticketsDs}`);
  console.log(`  Pull Requests database ${env.prDb}  ->  data source ${prDs}`);
  console.log(`  Ticket key prefix: ${config.ticketKeyPrefix}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

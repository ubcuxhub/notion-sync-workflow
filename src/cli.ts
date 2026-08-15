/**
 * Local entrypoint — the same pipeline the Action runs, driven by flags.
 *
 *   npm run sync -- --repo acme/ux-hub-web --pr 42
 *   DRY_RUN=1 npm run sync -- --repo acme/ux-hub-web --pr 42
 *   npm run sync -- --reconcile --since-days 30
 *   npm run sync -- --reconcile --repos acme/a,acme/b
 *
 * Driving a live PR through `--repo/--pr` is what makes this testable without
 * a webhook: it fetches the PR from the API and runs the identical event path.
 */

import "dotenv/config";
import { fetchPr } from "./github/client.js";
import { runEvent } from "./modes/event.js";
import { runReconcile } from "./modes/reconcile.js";
import { render } from "./modes/summary.js";
import { bootstrap } from "./run.js";

interface Args {
  repo?: string;
  pr?: number;
  reconcile: boolean;
  repos?: string[];
  sinceDays?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { reconcile: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--repo") args.repo = next();
    else if (flag === "--pr") args.pr = Number(next());
    else if (flag === "--reconcile") args.reconcile = true;
    else if (flag === "--repos") args.repos = (next() ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    else if (flag === "--since-days") args.sinceDays = Number(next());
    else if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`Unknown flag: ${flag}\n${USAGE}`);
  }
  return args;
}

const USAGE = `Usage:
  sync --repo <owner/name> --pr <number>     sync one PR
  sync --reconcile [--repos a,b] [--since-days N]

Environment: NOTION_TOKEN, NOTION_TICKETS_DB, NOTION_PR_DB, GITHUB_TOKEN, DRY_RUN`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { ctx, gh, config } = await bootstrap((msg) => console.log(msg));

  if (ctx.dryRun) console.log("DRY RUN — no writes will be made\n");

  if (args.reconcile) {
    const repos = args.repos ?? config.repos;
    if (repos.length === 0) throw new Error("No repos given. Pass --repos or fill in sync.config.json.");
    const days = args.sinceDays ?? config.reconcileSinceDays;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    console.log(`Reconciling ${repos.join(", ")} since ${since.toISOString()}\n`);

    const summary = await runReconcile(ctx, gh, config, { repos, since });
    console.log(`\n${render(summary, ctx.dryRun)}`);
    return;
  }

  if (!args.repo || !args.pr) throw new Error(`Need --repo and --pr.\n${USAGE}`);

  const pr = await fetchPr(gh, args.repo, args.pr);
  const summary = await runEvent(ctx, gh, pr, config);
  console.log(`\n${render(summary, ctx.dryRun)}`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

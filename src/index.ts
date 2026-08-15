/** GitHub Action entrypoint. Runs the event path for the PR that fired the workflow. */

import * as core from "@actions/core";
import { prFromEvent } from "./github/client.js";
import { runEvent } from "./modes/event.js";
import { runReconcile } from "./modes/reconcile.js";
import { render, writeJobSummary } from "./modes/summary.js";
import { bootstrap } from "./run.js";

async function main(): Promise<void> {
  const mode = core.getInput("mode") || "event";
  const { ctx, gh, config } = await bootstrap((msg) => core.info(msg));

  if (mode === "reconcile") {
    const days = Number(core.getInput("since-days") || config.reconcileSinceDays);
    const repos = (core.getInput("repos") || config.repos.join(",")).split(",").map((r) => r.trim()).filter(Boolean);
    if (repos.length === 0) {
      core.warning("No repos configured — nothing to reconcile. Add them to sync.config.json.");
      return;
    }
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    core.info(`Reconciling ${repos.length} repo(s) since ${since.toISOString()}`);

    const summary = await runReconcile(ctx, gh, config, { repos, since });
    writeJobSummary(summary, ctx.dryRun);
    core.info(render(summary, ctx.dryRun));
    for (const warning of summary.warnings) core.warning(warning);
    return;
  }

  const pr = prFromEvent();
  if (!pr) {
    // A trigger that carries no pull_request is a workflow misconfiguration, not
    // a sync failure — say so and exit green.
    core.warning("No pull_request in the event payload; nothing to sync.");
    return;
  }

  const summary = await runEvent(ctx, gh, pr, config);
  writeJobSummary(summary, ctx.dryRun);
  for (const warning of summary.warnings) core.warning(warning);
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});

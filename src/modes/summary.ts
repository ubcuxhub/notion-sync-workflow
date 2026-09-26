import { appendFileSync } from "node:fs";

export interface RunSummary {
  prs: { repo: string; number: number; state: string; outcome: "created" | "updated" | "unchanged" }[];
  /** Notion edits written to GitHub. */
  pushes: { repo: string; number: number; what: string }[];
  ticketChanges: { ticketId: string; from: string; to: string }[];
  unlinked: string[];
  warnings: string[];
}

export function emptySummary(): RunSummary {
  return { prs: [], pushes: [], ticketChanges: [], unlinked: [], warnings: [] };
}

/** Fold one PR's sync result into a run summary. */
export function record(
  summary: RunSummary,
  result: { pr: { repo: string; number: number }; state: string; outcome: RunSummary["prs"][number]["outcome"]; linked: boolean; pushed: string[]; warnings: string[] },
): void {
  const { repo, number } = result.pr;
  summary.prs.push({ repo, number, state: result.state, outcome: result.outcome });
  for (const what of result.pushed) summary.pushes.push({ repo, number, what });
  if (!result.linked) summary.unlinked.push(`${repo}#${number}`);
  summary.warnings.push(...result.warnings);
}

export function merge(into: RunSummary, from: RunSummary): RunSummary {
  into.prs.push(...from.prs);
  into.pushes.push(...from.pushes);
  into.ticketChanges.push(...from.ticketChanges);
  into.unlinked.push(...from.unlinked);
  into.warnings.push(...from.warnings);
  return into;
}

export function render(summary: RunSummary, dryRun: boolean): string {
  const lines: string[] = [`## Notion sync${dryRun ? " (dry run)" : ""}`, ""];

  if (summary.prs.length) {
    lines.push("| PR | State | |", "|---|---|---|");
    for (const pr of summary.prs) {
      lines.push(`| ${pr.repo}#${pr.number} | ${pr.state} | ${pr.outcome} |`);
    }
    lines.push("");
  } else {
    lines.push("_No pull requests synced._", "");
  }

  if (summary.pushes.length) {
    lines.push("**Pushed to GitHub from Notion**", "");
    for (const push of summary.pushes) lines.push(`- ${push.repo}#${push.number}: ${push.what}`);
    lines.push("");
  }

  if (summary.ticketChanges.length) {
    lines.push("**Ticket status changes**", "");
    for (const t of summary.ticketChanges) lines.push(`- \`${t.ticketId}\`: ${t.from} → ${t.to}`);
    lines.push("");
  }

  // Surfaced rather than failed: an unresolved ticket reference is a human
  // problem, and blocking a merge on it would be the wrong trade.
  if (summary.unlinked.length) {
    lines.push(`**Unlinked** (${summary.unlinked.length}) — see the triage view`, "");
    for (const u of summary.unlinked) lines.push(`- ${u}`);
    lines.push("");
  }

  if (summary.warnings.length) {
    lines.push("**Warnings**", "");
    for (const w of summary.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function writeJobSummary(summary: RunSummary, dryRun: boolean): void {
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (!path) return;
  appendFileSync(path, `${render(summary, dryRun)}\n`);
}

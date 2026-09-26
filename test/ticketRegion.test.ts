import { describe, expect, it } from "vitest";
import { resolveTicketRefs } from "../src/core/resolveTicketKeys.js";
import { hasTicketRegion, writeTicketRegion } from "../src/core/ticketRegion.js";
import { pr } from "./helpers.js";

const REGION = (line: string) => `<!-- notion-sync:tickets -->\n${line}\n<!-- /notion-sync:tickets -->`;

describe("writeTicketRegion", () => {
  it("appends a region to a body without one", () => {
    expect(writeTicketRegion("Some change.\n\n", ["UX-3"])).toBe(`Some change.\n\n${REGION("Ticket: UX-3")}\n`);
  });

  it("writes a region into an empty body", () => {
    expect(writeTicketRegion("", ["UX-3", "UX-7"])).toBe(`${REGION("Ticket: UX-3, UX-7")}\n`);
  });

  it("replaces an existing region and leaves the rest alone", () => {
    const body = `Intro\n\n${REGION("Ticket: UX-3")}\n\nOutro`;
    expect(writeTicketRegion(body, ["UX-9"])).toBe(`Intro\n\n${REGION("Ticket: UX-9")}\n\nOutro`);
  });

  it("writes an explicit none when every ticket is removed", () => {
    const out = writeTicketRegion(REGION("Ticket: UX-3"), []);
    expect(out).toBe(REGION("Ticket: none"));
    expect(hasTicketRegion(out)).toBe(true);
  });

  it("is idempotent", () => {
    const once = writeTicketRegion("Body", ["UX-1"]);
    expect(writeTicketRegion(once, ["UX-1"])).toBe(once);
  });
});

describe("resolveTicketRefs with a region", () => {
  const keys = (refs: ReturnType<typeof resolveTicketRefs>) => refs.map((r) => r.value);

  it("reads the directive inside the region", () => {
    expect(keys(resolveTicketRefs(pr({ body: REGION("Ticket: UX-3, UX-7") }), "UX"))).toEqual([3, 7]);
  });

  it("stops the branch fallback when the region says none", () => {
    const p = pr({ body: REGION("Ticket: none"), branch: "ux-2-thing", title: "[UX-5] x" });
    expect(resolveTicketRefs(p, "UX")).toEqual([]);
  });

  it("combines the region with a hand-written directive elsewhere", () => {
    const p = pr({ body: `Closes UX-5\n\n${REGION("Ticket: UX-3")}` });
    expect(keys(resolveTicketRefs(p, "UX"))).toEqual([5, 3]);
  });
});

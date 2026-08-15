import { describe, expect, it } from "vitest";
import { normalizeId, resolveTicketRefs } from "../src/core/resolveTicketKeys.js";
import { pr } from "./helpers.js";

const keys = (refs: ReturnType<typeof resolveTicketRefs>) =>
  refs.filter((r) => r.kind === "key").map((r) => r.value);

describe("resolveTicketRefs", () => {
  it("finds a Ticket: directive in the body", () => {
    expect(keys(resolveTicketRefs(pr({ body: "Ticket: UX-12" }), "UX"))).toEqual([12]);
  });

  it("accepts closing keywords", () => {
    expect(keys(resolveTicketRefs(pr({ body: "Closes UX-7" }), "UX"))).toEqual([7]);
    expect(keys(resolveTicketRefs(pr({ body: "Fixes UX-8" }), "UX"))).toEqual([8]);
    expect(keys(resolveTicketRefs(pr({ body: "resolves ux-9" }), "UX"))).toEqual([9]);
  });

  it("collects several tickets from one PR", () => {
    expect(keys(resolveTicketRefs(pr({ body: "Ticket: UX-1, UX-2" }), "UX"))).toEqual([1, 2]);
    expect(keys(resolveTicketRefs(pr({ body: "Closes UX-1\nCloses UX-2" }), "UX"))).toEqual([1, 2]);
  });

  it("falls back to the branch name", () => {
    expect(keys(resolveTicketRefs(pr({ branch: "feat/UX-12/tokens" }), "UX"))).toEqual([12]);
    expect(keys(resolveTicketRefs(pr({ branch: "ux-13-tokens" }), "UX"))).toEqual([13]);
  });

  it("falls back to a title prefix", () => {
    expect(keys(resolveTicketRefs(pr({ title: "[UX-14] Tidy tokens" }), "UX"))).toEqual([14]);
    expect(keys(resolveTicketRefs(pr({ title: "UX-15: Tidy tokens" }), "UX"))).toEqual([15]);
  });

  // A key in the middle of a title is usually prose ("follow-up to UX-3"), not a
  // claim that this PR serves that ticket.
  it("ignores a key buried mid-title", () => {
    expect(resolveTicketRefs(pr({ title: "Tidy tokens, follow-up to UX-3" }), "UX")).toEqual([]);
  });

  it("prefers the body over branch and title", () => {
    const p = pr({ body: "Ticket: UX-1", branch: "ux-2-x", title: "[UX-3] x" });
    expect(keys(resolveTicketRefs(p, "UX"))).toEqual([1]);
  });

  it("prefers the branch over the title", () => {
    expect(keys(resolveTicketRefs(pr({ branch: "ux-2-x", title: "[UX-3] x" }), "UX"))).toEqual([2]);
  });

  it("returns nothing when there is no reference at all", () => {
    expect(resolveTicketRefs(pr({ body: "Just a tidy-up." }), "UX")).toEqual([]);
  });

  it("does not match a different prefix", () => {
    expect(resolveTicketRefs(pr({ body: "Ticket: ENG-12" }), "UX")).toEqual([]);
  });

  it("deduplicates repeated references", () => {
    expect(keys(resolveTicketRefs(pr({ body: "Ticket: UX-5\nAlso closes UX-5" }), "UX"))).toEqual([5]);
  });

  it("picks up a pasted Notion page URL", () => {
    const body = "Ticket: https://www.notion.so/acme/Fix-the-thing-1f2e3d4c5b6a78901234567890abcdef";
    const refs = resolveTicketRefs(pr({ body }), "UX");
    expect(refs).toEqual([{ kind: "page", value: "1f2e3d4c-5b6a-7890-1234-567890abcdef" }]);
  });

  it("takes both a key and a URL from the same body", () => {
    const body = "Ticket: UX-4\nsee also https://notion.so/1f2e3d4c5b6a78901234567890abcdef";
    const refs = resolveTicketRefs(pr({ body }), "UX");
    expect(refs).toHaveLength(2);
    expect(keys(refs)).toEqual([4]);
  });

  // Template comments are stripped before rendering, but ref resolution reads the
  // raw body — a commented-out example key must not become a real link.
  it("does not resolve keys inside HTML comments", () => {
    const body = "<!-- Ticket: UX-99 -->\nNo ticket for this one.";
    expect(resolveTicketRefs(pr({ body }), "UX")).toEqual([]);
  });
});

describe("normalizeId", () => {
  it("dashes a bare 32-char id", () => {
    expect(normalizeId("1f2e3d4c5b6a78901234567890abcdef")).toBe("1f2e3d4c-5b6a-7890-1234-567890abcdef");
  });

  it("leaves an already-dashed id alone", () => {
    const id = "1f2e3d4c-5b6a-7890-1234-567890abcdef";
    expect(normalizeId(id)).toBe(id);
  });
});

import { describe, expect, it } from "vitest";
import { computeTicketStatus, decideTicketWrite } from "../src/core/computeTicketStatus.js";

const open = { merged: false, closed: false };
const merged = { merged: true, closed: true };
const abandoned = { merged: false, closed: true };

describe("computeTicketStatus", () => {
  it("is Draft with no linked PRs", () => {
    expect(computeTicketStatus([])).toBe("Draft");
  });

  it("is In review while any PR is still open", () => {
    expect(computeTicketStatus([open])).toBe("In review");
    expect(computeTicketStatus([merged, open])).toBe("In review");
  });

  it("is Completed once every PR is merged", () => {
    expect(computeTicketStatus([merged])).toBe("Completed");
    expect(computeTicketStatus([merged, merged])).toBe("Completed");
  });

  // The point of excluding abandoned PRs: one closed-unmerged attempt should not
  // hold a ticket at In review after the real work landed.
  it("ignores closed-unmerged PRs when the rest are merged", () => {
    expect(computeTicketStatus([abandoned, merged])).toBe("Completed");
  });

  it("still counts open PRs alongside abandoned ones", () => {
    expect(computeTicketStatus([abandoned, open])).toBe("In review");
  });

  // No work stands, so the ticket goes back to the top of the board rather than
  // claiming to be finished.
  it("is Draft when every linked PR was abandoned", () => {
    expect(computeTicketStatus([abandoned])).toBe("Draft");
    expect(computeTicketStatus([abandoned, abandoned])).toBe("Draft");
  });
});

describe("decideTicketWrite", () => {
  it("writes nothing when the status already matches", () => {
    expect(decideTicketWrite("In review", "In review")).toBeNull();
    expect(decideTicketWrite("Completed", "Completed")).toBeNull();
  });

  it("promotes as work progresses", () => {
    expect(decideTicketWrite("Draft", "In review")).toBe("In review");
    expect(decideTicketWrite("Ready", "In review")).toBe("In review");
    expect(decideTicketWrite("Assigned", "In review")).toBe("In review");
    expect(decideTicketWrite("In review", "Completed")).toBe("Completed");
    expect(decideTicketWrite("Draft", "Completed")).toBe("Completed");
  });

  it("pulls a ticket back off Completed when the work no longer stands", () => {
    expect(decideTicketWrite("Completed", "In review")).toBe("In review");
    // Retracting its own claim is the one case where sync may write Draft.
    expect(decideTicketWrite("Completed", "Draft")).toBe("Draft");
  });

  // The bug this rule exists for: someone picks up a ticket and moves it to
  // Assigned before opening a PR, and the next sweep shoved it back to Draft.
  it("never demotes a human's Assigned to Draft", () => {
    expect(decideTicketWrite("Assigned", "Draft")).toBeNull();
  });

  // An abandoned PR retracts In review, but whoever opened it still has the
  // ticket, so it goes back to Assigned rather than the top of the board.
  it("drops a ticket from In review to Assigned when its PRs are abandoned", () => {
    expect(decideTicketWrite("In review", "Draft")).toBe("Assigned");
  });

  it("leaves an untouched Draft alone", () => {
    expect(decideTicketWrite("Draft", "Draft")).toBeNull();
    expect(decideTicketWrite(undefined, "Draft")).toBeNull();
  });
});

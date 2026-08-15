import { describe, expect, it } from "vitest";
import { deriveState } from "../src/core/deriveState.js";
import { pr } from "./helpers.js";

describe("deriveState", () => {
  it("maps an open PR with no reviews to Open", () => {
    expect(deriveState(pr(), null)).toBe("Open");
  });

  it("maps a draft to Draft", () => {
    expect(deriveState(pr({ draft: true }), null)).toBe("Draft");
  });

  it("maps review decisions onto their substates", () => {
    expect(deriveState(pr(), "REVIEW_REQUIRED")).toBe("In review");
    expect(deriveState(pr(), "APPROVED")).toBe("Approved");
    expect(deriveState(pr(), "CHANGES_REQUESTED")).toBe("Changes requested");
  });

  it("maps a merged PR to Merged", () => {
    const merged = pr({ merged: true, mergedAt: "2026-08-03T10:00:00Z", closedAt: "2026-08-03T10:00:00Z" });
    expect(deriveState(merged, null)).toBe("Merged");
  });

  it("maps a closed-unmerged PR to Closed", () => {
    expect(deriveState(pr({ closedAt: "2026-08-03T10:00:00Z" }), null)).toBe("Closed");
  });

  // GitHub keeps reporting the last review verdict after a merge; the terminal
  // state has to win or merged PRs sit in "Changes requested" forever.
  it("lets terminal states outrank a stale review decision", () => {
    const merged = pr({ merged: true, closedAt: "2026-08-03T10:00:00Z" });
    expect(deriveState(merged, "CHANGES_REQUESTED")).toBe("Merged");
    expect(deriveState(pr({ closedAt: "2026-08-03T10:00:00Z" }), "APPROVED")).toBe("Closed");
  });

  it("lets draft outrank a review decision", () => {
    expect(deriveState(pr({ draft: true }), "REVIEW_REQUIRED")).toBe("Draft");
  });

  it("collapses to Open when review states are disabled", () => {
    // reviewStates: false means the GraphQL call is skipped and null passed.
    expect(deriveState(pr(), null)).toBe("Open");
  });
});

import { describe, expect, it } from "vitest";
import { mergeSet, parseShadow, serializeShadow } from "../src/core/mergeField.js";

describe("mergeSet", () => {
  // [case, shadow, notion, github, desired, pending]
  const cases: [string, string[] | null, string[], string[], string[], boolean][] = [
    ["nothing changed", ["a"], ["a"], ["a"], ["a"], false],
    ["no shadow: GitHub wins", null, ["a", "x"], ["a"], ["a"], false],
    ["no shadow on an empty row", null, [], ["a"], ["a"], false],
    ["Notion added", ["a"], ["a", "b"], ["a"], ["a", "b"], true],
    ["Notion removed", ["a", "b"], ["a"], ["a", "b"], ["a"], true],
    ["Notion emptied", ["a"], [], ["a"], [], true],
    ["GitHub added", ["a"], ["a"], ["a", "b"], ["a", "b"], false],
    ["GitHub removed", ["a", "b"], ["a", "b"], ["a"], ["a"], false],
    ["both added different values", ["a"], ["a", "n"], ["a", "g"], ["a", "g", "n"], true],
    ["both made the same edit", ["a"], ["a", "b"], ["a", "b"], ["a", "b"], false],
    ["Notion removed what GitHub also dropped", ["a", "b"], ["a"], ["a"], ["a"], false],
    ["Notion removed while GitHub added", ["a", "b"], ["a"], ["a", "b", "c"], ["a", "c"], true],
  ];

  it.each(cases)("%s", (_, shadow, notion, github, desired, pending) => {
    expect(mergeSet(shadow, notion, github)).toEqual({ desired, pending });
  });

  it("ignores order", () => {
    expect(mergeSet(["b", "a"], ["a", "b"], ["b", "a"]).pending).toBe(false);
  });
});

describe("shadow encoding", () => {
  it("round-trips, sorted", () => {
    expect(parseShadow(serializeShadow(["b", "a"]))).toEqual(["a", "b"]);
  });

  it("keeps a known-empty value distinct from never-written", () => {
    expect(parseShadow(serializeShadow([]))).toEqual([]);
    expect(parseShadow("")).toBeNull();
  });

  it("treats garbage as absent", () => {
    expect(parseShadow("not json")).toBeNull();
    expect(parseShadow('{"a":1}')).toBeNull();
  });
});

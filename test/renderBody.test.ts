import { describe, expect, it } from "vitest";
import { chunkBlocks, renderBody } from "../src/core/renderBody.js";

const types = (blocks: ReturnType<typeof renderBody>) => blocks.map((b) => b["type"]);

describe("renderBody", () => {
  it("returns nothing for an empty body", () => {
    expect(renderBody("")).toEqual([]);
    expect(renderBody("   \n  ")).toEqual([]);
  });

  it("converts headings, lists and code", () => {
    const md = ["# Summary", "", "- one", "- two", "", "```ts", "const x = 1;", "```"].join("\n");
    expect(types(renderBody(md))).toEqual([
      "heading_1",
      "bulleted_list_item",
      "bulleted_list_item",
      "code",
    ]);
  });

  it("strips HTML comments from PR templates", () => {
    const blocks = renderBody("<!-- please describe your change -->\nReal content.");
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain("please describe");
  });

  it("drops images but keeps their alt text", () => {
    const blocks = renderBody("Before ![a screenshot](https://private/x.png) after");
    const json = JSON.stringify(blocks);
    expect(json).toContain("image: a screenshot");
    expect(json).not.toContain("private/x.png");
  });

  it("produces no image blocks Notion would reject", () => {
    expect(types(renderBody("![](https://private/x.png)"))).not.toContain("image");
  });

  it("survives a very long body", () => {
    const blocks = renderBody("word ".repeat(5000));
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe("chunkBlocks", () => {
  it("splits into 100-block chunks", () => {
    const blocks = Array.from({ length: 250 }, (_, i) => ({ type: "paragraph", i }));
    const chunks = chunkBlocks(blocks);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it("leaves a short body as one chunk", () => {
    expect(chunkBlocks([{ type: "paragraph" }])).toHaveLength(1);
  });

  it("returns nothing for no blocks", () => {
    expect(chunkBlocks([])).toEqual([]);
  });
});

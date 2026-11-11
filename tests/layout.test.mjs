import test from "node:test";
import assert from "node:assert/strict";
import { normaliseLayout, moveItem, sectionForHash, SECTIONS } from "../scripts/dashboard-layout.mjs";

const groups = { live: ["mix", "agile_now", "clean"], prices: ["agile", "tracker"] };

test("a new visitor gets the generation pie first and no pinned graphs", () => {
  const layout = normaliseLayout(null, groups);
  assert.deepEqual(layout, { pins: [], order: groups });
  assert.equal(SECTIONS[0].id, "live");
});
test("stored preferences discard deleted, foreign and duplicate chart identifiers", () => {
  const layout = normaliseLayout({ pins: ["mix", "mix", "deleted", null, "tracker"], order: { live: ["clean", "tracker", "clean", "gone"] } }, groups);
  assert.deepEqual(layout.pins, ["mix", "tracker"]);
  assert.deepEqual(layout.order.live, ["clean", "mix", "agile_now"]);
  assert.deepEqual(layout.order.prices, ["agile", "tracker"]);
});
test("newly added charts remain reachable after restoring an older layout", () => {
  const layout = normaliseLayout({ order: { live: ["agile_now", "mix"] } }, groups);
  assert.deepEqual(layout.order.live, ["agile_now", "mix", "clean"]);
});
test("invalid stored preference shapes fall back safely", () => {
  for (const value of [false, "bad", [], { pins: {}, order: [] }, { pins: 1, order: { live: "mix" } }]) {
    assert.deepEqual(normaliseLayout(value, groups), { pins: [], order: groups });
  }
});
test("moving graphs changes only the requested adjacent pair and preserves the input", () => {
  const list = ["mix", "agile_now", "clean"];
  assert.deepEqual(moveItem(list, "agile_now", -1), ["agile_now", "mix", "clean"]);
  assert.deepEqual(moveItem(list, "agile_now", 1), ["mix", "clean", "agile_now"]);
  assert.deepEqual(list, groups.live);
});
test("moving a graph cannot cross a boundary or insert an unknown graph", () => {
  for (const [id, dir] of [["mix", -1], ["clean", 1], ["absent", 1], ["mix", 10]]) assert.deepEqual(moveItem(groups.live, id, dir), groups.live);
});
test("section links and old bookmarked headings resolve to visible page sections", () => {
  assert.equal(sectionForHash('#generation'), 'generation');assert.equal(sectionForHash('#history'), 'generation');
  assert.equal(sectionForHash('#h-hist'), 'generation');assert.equal(sectionForHash('#h-dem'), 'demand');
  assert.equal(sectionForHash('#%broken'), 'live');
});
test("generation and demand have separate navigation destinations",()=>{
  assert(SECTIONS.some(s=>s.id==='generation'&&s.sections.includes('h-hist')));
  assert(SECTIONS.some(s=>s.id==='demand'&&s.sections.includes('h-dem')));
});

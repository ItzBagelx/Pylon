import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

function scheduler() {
  let clock = Date.parse("2026-11-06T18:00:00Z");
  const calls = [], CACHE = new Map([["old", true]]), PRICE_HISTORY = new Map([["old", true]]);
  const names = ["refreshNow", "refreshAgile", "refreshTracker", "refreshPies", "refreshHistory", "refreshYoY", "refreshDemand", "refreshMid", "refreshBat", "refreshFc", "refreshRec"];
  const context = { Date: { now: () => clock }, CACHE, PRICE_HISTORY, Promise, document: { hidden: false }, S: { pieRange: 0, range: 720, demRange: 720, midRange: 720 } };
  for (const name of names) context[name] = async () => calls.push(name);
  const start = script.indexOf("  // Use elapsed time:");
  const end = script.indexOf("  function rerenderAll()", start);
  vm.createContext(context);
  vm.runInContext(script.slice(start, end) + "globalThis.api = { refreshAll, resumeRefresh };", context);
  return { ...context.api, calls, CACHE, PRICE_HISTORY, document: context.document, advance: ms => { clock += ms; } };
}

test("a returning tab refreshes the outlook and all summaries and drops cached responses", async () => {
  const s = scheduler(); await s.refreshAll(true); s.calls.length = 0;
  s.advance(8 * 36e5); await s.resumeRefresh();
  for (const name of ["refreshFc", "refreshBat", "refreshRec", "refreshYoY", "refreshHistory"]) assert(s.calls.includes(name));
  assert.equal(s.CACHE.size, 0); assert.equal(s.PRICE_HISTORY.size, 0);
});

test("foreground five-minute checks always include the wind and solar outlook", async () => {
  const s = scheduler(); await s.refreshAll(true); s.calls.length = 0;
  s.advance(5 * 60000); await s.refreshAll(false);
  assert(s.calls.includes("refreshFc")); assert(s.calls.includes("refreshBat"));
  assert(!s.calls.includes("refreshRec"));
});

test("summaries become due after elapsed time even if background timers never fired", async () => {
  const s = scheduler(); await s.refreshAll(true); s.calls.length = 0;
  s.advance(31 * 60000); await s.refreshAll(false);
  assert(s.calls.includes("refreshRec")); assert(s.calls.includes("refreshYoY"));
});

test("hidden tabs do not launch a resume refresh", async () => {
  const s = scheduler(); await s.refreshAll(true); s.calls.length = 0;
  s.advance(8 * 36e5); s.document.hidden = true; await s.resumeRefresh();
  assert.equal(s.calls.length, 0);
});

test("focus and visibility events arriving together do not double the refresh", async () => {
  const s = scheduler(); await s.refreshAll(true); s.calls.length = 0;
  s.advance(8 * 36e5); await s.resumeRefresh(); const first = s.calls.length;
  await s.resumeRefresh(); assert.equal(s.calls.length, first);
});

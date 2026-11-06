import test from "node:test";
import assert from "node:assert/strict";
import { assembleOutlook } from "../scripts/build-outlook.mjs";

const HH = 18e5, HOUR = 36e5;
const now = Date.parse("2026-11-06T15:15:00Z"), cut = Date.parse("2026-11-06T15:00:00Z");
const data = () => ({
  now,
  windActual: [{ fuelType: "WIND", startTime: "2026-11-06T14:30:00Z", publishTime: "2026-11-06T15:00:00Z", generation: 1700 }],
  demandUpdate: [{ t: cut - HH, wind: 300, solar: 1000, act: false }],
  embeddedForecast: Array.from({ length: 8 }, (_, i) => ({ t: cut + i * HH, wind: 200 + i, solar: 800 - i * 100 })),
  windForecast: [{ t: cut, mw: 1600, pub: "2026-11-06T11:30:00Z" }, { t: cut + HOUR, mw: 1500, pub: "2026-11-06T11:30:00Z" }]
});

test("recent metered wind replaces the old history and keeps small-farm forecast provenance", () => {
  const input = data();
  input.previous = { past: [[cut - HH, 9000, 300, 1000, 2]] };
  const out = assembleOutlook(input), latest = out.past.at(-1);
  assert.deepEqual(latest, [cut - HH, 1700, 300, 1000, 2]);
  assert.equal(out.past.length, 96);
});

test("missing history remains a missing half-hour, never zero or compressed time", () => {
  const out = assembleOutlook(data());
  assert.deepEqual(out.past[0].slice(1, 4), [null, null, null]);
  const timeline = [...out.past, ...out.fut];
  assert(timeline.every((row, i) => i === 0 || row[0] - timeline[i - 1][0] === HH));
});

test("hourly wind applies to its two half-hours and stops at the forecast horizon", () => {
  const out = assembleOutlook(data());
  assert.deepEqual(out.fut.map(row => row[1]), [1600, 1600, 1500, 1500]);
  assert.equal(out.fut.at(-1)[0] + HH, cut + 2 * HOUR);
});

test("a missing forecast hour is a gap rather than the nearest hour's value", () => {
  const input = data(); input.windForecast[1].t = cut + 2 * HOUR;
  const out = assembleOutlook(input);
  assert.equal(out.fut[2][1], null); assert.equal(out.fut[3][1], null);
});

test("an older forecast run cannot extend or replace the latest run", () => {
  const input = data();
  input.windForecast.push({ t: cut + 3 * HOUR, mw: 9999, pub: "2026-11-06T04:30:00Z" });
  const out = assembleOutlook(input);
  assert.equal(out.fut.length, 4);
  assert.equal(out.windPublished, "2026-11-06T11:30:00Z");
});

test("new embedded forecasts cannot overwrite reported embedded outturn", () => {
  const input = data();
  input.demandUpdate = [{ t: cut - HH, wind: 250, solar: 900, act: true }, { t: cut - HH, wind: 600, solar: 2000, act: false }];
  input.embeddedForecast.push({ t: cut - HH, wind: 500, solar: 1500 });
  assert.deepEqual(assembleOutlook(input).past.at(-1), [cut - HH, 1700, 250, 900, 0]);
});

test("an incomplete current half-hour is not treated as metered history", () => {
  const input = data();
  input.windActual.push({ fuelType: "WIND", startTime: "2026-11-06T15:00:00Z", publishTime: "2026-11-06T15:10:00Z", generation: 9999 });
  const out = assembleOutlook(input);
  assert.equal(out.fut[0][1], 1600); assert.equal(out.fut[0][4], 3);
});

test("temporary actual-source failure retains the previous known actuals", () => {
  const input = data(); input.windActual = [];
  input.previous = { past: [[cut - HH, 1700, 300, 1000, 2]] };
  assert.equal(assembleOutlook(input).past.at(-1)[1], 1700);
});

test("missing required forecasts fail before the previous file can be replaced", () => {
  const input = data(); input.windForecast = [];
  assert.throws(() => assembleOutlook(input), /previous outlook retained/);
});

test("negative, null and nonnumeric data are not converted into valid output", () => {
  const input = data(); input.demandUpdate[0].wind = -10; input.demandUpdate[0].solar = null;
  const out = assembleOutlook(input);
  assert.deepEqual(out.past.at(-1).slice(1, 4), [1700, null, null]);
});

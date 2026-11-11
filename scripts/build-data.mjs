// Pylon data builder. Runs hourly in GitHub Actions and writes small JSON files to data/ that the site reads
// for its 30-day and 1-year views, records, battery activity, embedded generation and forecasts.
//
// Sources (all public, no keys):
//   NESO historic generation mix (half-hourly MW by fuel, including embedded wind and solar, and carbon intensity)
//   NESO demand data update and embedded wind/solar forecast
//   Elexon Insights: interconnector flows, demand outturn, market index price, wind forecast,
//                    battery units and their physical notifications
import fs from "node:fs/promises";
import path from "node:path";
import { buildAgilePrices } from "./build-agile.mjs";
import { assembleOutlook } from "./build-outlook.mjs";
import { snapshotFromElexon, mergeGenerationDays } from "./generation-series.mjs";

const E = "https://data.elexon.co.uk/bmrs/api/v1";
const NESO = "https://api.neso.energy/api/3/action";
const MIX = "f93d1835-75bc-43e5-84ad-12472b180a98";
const DDU = "https://api.neso.energy/dataset/7a12172a-939c-404c-b581-a6128b74f588/resource/177f6fa4-ae49-4182-81ea-0c6b35f26ca6/download/demanddataupdate.csv";
const HH = 18e5, DAY = 864e5;
const KEEP = 760;    // days kept: two years for last-year comparisons, plus a margin
const REBUILD = 3;   // recent days are rebuilt every run because late readings keep arriving
const OUT = "data";
const IC = ["INTFR", "INTIFA2", "INTELEC", "INTNED", "INTNEM", "INTNSL", "INTVKL", "INTIRL", "INTEW", "INTGRNL"];
const FUELS = ["gas", "coal", "nuclear", "wind", "windEmb", "hydro", "biomass", "other", "solar", "storage"];
const now = Date.now();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ukDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const ukHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" });
const dkey = t => ukDay.format(new Date(t));
const iso = t => new Date(t).toISOString();
const sday = t => iso(t).slice(0, 10);
const r0 = Math.round, r1 = x => Math.round(x * 10) / 10;

async function get(url, { text = false, tries = 4, timeout = 240000 } = {}) {
  let err;
  for (let k = 0; k < tries; k++) {
    try {
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeout);
      const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "pylon-dashboard/1.0 (+https://github.com/ItzBagelx/Pylon)" } });
      clearTimeout(tm);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${url.slice(0, 140)}`);
      return text ? await r.text() : await r.json();
    } catch (e) { err = e; await new Promise(res => setTimeout(res, 3000 * (k + 1))); }
  }
  throw err;
}
const rows = j => Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
const chunks = (a, b, days) => { const out = []; for (let x = a; x < b; x += days * DAY) out.push([x, Math.min(b, x + days * DAY)]); return out; };
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(path.join(OUT, f), "utf8")); } catch { return d; } };
async function write(f, obj) {
  await fs.mkdir(OUT, { recursive: true });
  // arrays and day maps go one item per line, so each hourly commit only changes a few lines and git stores it compactly
  const s = "{" + Object.entries(obj).map(([k, v]) => {
    const body = Array.isArray(v) ? "[\n" + v.map(x => JSON.stringify(x)).join(",\n") + "\n]"
      : v && typeof v === "object" && Object.keys(v).length > 20 ? "{\n" + Object.entries(v).map(([a, b]) => JSON.stringify(a) + ":" + JSON.stringify(b)).join(",\n") + "\n}"
      : JSON.stringify(v);
    return JSON.stringify(k) + ":" + body;
  }).join(",\n") + "}\n";
  await fs.writeFile(path.join(OUT, f), s);
  log("wrote", f, (s.length / 1024).toFixed(0) + " KB");
}
// UTC start of a UK settlement date (period 1 starts at local midnight)
function ukMidnight(dateStr) {
  const t = Date.parse(dateStr + "T00:00:00Z");
  for (const c of [t, t - 36e5, t + 36e5]) if (dkey(c) === dateStr && ukHour.format(new Date(c)) === "0") return c;
  return t;
}
const isBST = t => +ukHour.format(new Date(t)) !== new Date(t).getUTCHours();
const sp = (dateStr, period) => ukMidnight(dateStr) + (period - 1) * HH;
function csv(text) {
  const lines = text.trim().split(/\r?\n/), head = lines[0].split(",").map(s => s.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(l => { const c = l.split(","); const o = {}; head.forEach((h, i) => o[h] = (c[i] || "").replace(/^"|"$/g, "")); return o; });
}

/* ---------------- sources ---------------- */

async function nesoMix(fromT) {
  // the SQL endpoint takes a date filter, so one request covers any range (two years is about 11 MB)
  const cols = ["DATETIME", "GAS", "COAL", "NUCLEAR", "WIND", "WIND_EMB", "HYDRO", "IMPORTS", "BIOMASS", "OTHER", "SOLAR", "STORAGE", "GENERATION", "CARBON_INTENSITY"];
  const sql = `SELECT ${cols.map(c => `"${c}"`).join(",")} FROM "${MIX}" WHERE "DATETIME" >= '${iso(fromT).slice(0, 19)}' ORDER BY "DATETIME" DESC`;
  const j = await get(`${NESO}/datastore_search_sql?sql=${encodeURIComponent(sql)}`);
  const recs = j.result.records;
  log("NESO mix rows", recs.length, "latest", recs[0]?.DATETIME, "oldest", recs[recs.length - 1]?.DATETIME);
  return recs;
}

async function icFlows(fromT) {
  const qs = IC.map(c => "fuelType=" + c).join("&");
  const parts = await pool(chunks(fromT - DAY, now + DAY, 30), 4, ([a, b]) =>
    get(`${E}/datasets/FUELHH/stream?settlementDateFrom=${sday(a)}&settlementDateTo=${sday(b)}&${qs}`));
  const m = new Map(), seen = new Set();
  parts.flatMap(rows).forEach(r => {
    if (!IC.includes(r.fuelType)) return;
    const k = r.startTime + r.fuelType; if (seen.has(k)) return; seen.add(k);
    const t = Date.parse(r.startTime), e = m.get(t) || { imp: 0, exp: 0 };
    if (r.generation > 0) e.imp += r.generation; else e.exp -= r.generation;
    m.set(t, e);
  });
  log("interconnector half-hours", m.size);
  return m;
}

async function demand(fromT) {
  const parts = await pool(chunks(fromT - DAY, now + DAY, 27), 4, ([a]) =>
    get(`${E}/demand/outturn?settlementDateFrom=${sday(a)}&settlementDateTo=${sday(Math.min(a + 27 * DAY, now + DAY))}&format=json`));
  const m = new Map();
  parts.flatMap(rows).forEach(r => { if (r.initialDemandOutturn != null) m.set(Date.parse(r.startTime), r.initialDemandOutturn); });
  log("demand half-hours", m.size);
  return m;
}

async function prices(fromT) {
  const parts = await pool(chunks(fromT, now, 120), 2, ([a, b]) => get(`${E}/datasets/MID/stream?from=${iso(a)}&to=${iso(b)}`));
  const m = new Map();
  parts.flatMap(rows).forEach(r => { if (r.dataProvider === "APXMIDP" && r.volume > 0) m.set(Date.parse(r.startTime), r.price); });
  log("price half-hours", m.size);
  return m;
}

// Battery BM units: name matches plus a supplementary list verified against NESO classifications.
// Physical notifications are planned positions, excluding accepted balancing instructions; they are not metered output.
async function batteries() {
  const units = rows(await get(`${E}/reference/bmunits/all`));
  const re = /batter|bess|energy storage|\bstorage\b/i;
  const verified = new Set(JSON.parse(await fs.readFile(new URL("./battery-units.json", import.meta.url), "utf8")).nationalGridBmUnits);
  const bat = units.filter(u => u.fuelType !== "PS" && u.elexonBmUnit && (re.test(u.bmUnitName || "") || re.test(u.leadPartyName || "") || (verified.has(u.nationalGridBmUnit) && /^[ET]_/.test(u.elexonBmUnit))));
  const ids = bat.map(u => u.elexonBmUnit);
  const capMW = bat.reduce((a, u) => a + Math.max(0, +u.generationCapacity || 0), 0);
  const from = Math.floor((now - 7 * DAY) / HH) * HH;
  const tasks = [];
  for (let k = 0; k < ids.length; k += 50) for (const [a, b] of chunks(from, now + HH, 2)) tasks.push([ids.slice(k, k + 50), a, b]);
  const parts = await pool(tasks, 4, ([g, a, b]) => get(`${E}/datasets/PN/stream?from=${iso(a)}&to=${iso(b)}&${g.map(u => "bmUnit=" + encodeURIComponent(u)).join("&")}`));
  const per = new Map(), seen = new Set();
  parts.flat().forEach(r => {
    const a = Date.parse(r.timeFrom), b = Date.parse(r.timeTo);
    if (!(b > a)) return;
    const id = r.bmUnit + r.timeFrom + r.timeTo; if (seen.has(id)) return; seen.add(id);
    const lvl = t => r.levelFrom + (r.levelTo - r.levelFrom) * (t - a) / (b - a);
    for (let s = Math.floor(a / HH) * HH; s < b; s += HH) {
      const x0 = Math.max(a, s), x1 = Math.min(b, s + HH);
      if (x1 <= x0) continue;
      const k = r.bmUnit + "|" + s;
      per.set(k, (per.get(k) || 0) + (lvl(x0) + lvl(x1)) / 2 * (x1 - x0) / HH);
    }
  });
  const hh = new Map();
  per.forEach((mw, k) => {
    const s = +k.split("|")[1], e = hh.get(s) || { dis: 0, chg: 0 };
    if (mw > 0) e.dis += mw; else e.chg -= mw;
    hh.set(s, e);
  });
  log("battery units", ids.length, "capacity", r0(capMW), "MW, half-hours", hh.size);
  return { hh, units: ids.length, capMW };
}

const csvNumber = value => value == null || String(value).trim() === "" ? null : Number(value);
async function embeddedForecast() {
  const pkg = await get(`${NESO}/package_show?id=embedded-wind-and-solar-forecasts`, { timeout: 45000, tries: 2 });
  const res = pkg.result.resources.find(r => r.name === "Embedded Solar and Wind Forecast");
  const list = csv(await get(res.url, { text: true, timeout: 45000, tries: 2 }));
  const result = list.map(r => ({ t: sp(r.SETTLEMENT_DATE.slice(0, 10), +r.SETTLEMENT_PERIOD), wind: csvNumber(r.EMBEDDED_WIND_FORECAST), solar: csvNumber(r.EMBEDDED_SOLAR_FORECAST), capW: csvNumber(r.EMBEDDED_WIND_CAPACITY), capS: csvNumber(r.EMBEDDED_SOLAR_CAPACITY) }))
    .filter(r => isFinite(r.t)).sort((a, b) => a.t - b.t);
  result.published = res.last_modified ? res.last_modified + (/(Z|[+-]\d\d:\d\d)$/.test(res.last_modified) ? "" : "Z") : null;
  return result;
}

async function demandUpdate() {
  const list = csv(await get(DDU, { text: true, timeout: 45000, tries: 2 }));
  return list.map(r => ({ t: sp(r.SETTLEMENT_DATE.slice(0, 10), +r.SETTLEMENT_PERIOD), act: r.FORECAST_ACTUAL_INDICATOR === "A", wind: csvNumber(r.EMBEDDED_WIND_GENERATION), solar: csvNumber(r.EMBEDDED_SOLAR_GENERATION), capW: csvNumber(r.EMBEDDED_WIND_CAPACITY), capS: csvNumber(r.EMBEDDED_SOLAR_CAPACITY) }))
    .filter(r => isFinite(r.t)).sort((a, b) => a.t - b.t);
}

async function windForecast() {
  const list = rows(await get(`${E}/datasets/WINDFOR?publishDateTimeFrom=${iso(now - 10 * 36e5)}&publishDateTimeTo=${iso(now)}&format=json`, { timeout: 45000, tries: 2 }));
  const best = new Map();
  list.forEach(r => { const b = best.get(r.startTime); if (!b || r.publishTime > b.publishTime) best.set(r.startTime, r); });
  return [...best.values()].map(r => ({ t: Date.parse(r.startTime), mw: r.generation, pub: r.publishTime })).sort((a, b) => a.t - b.t);
}

async function windOutturn() {
  return rows(await get(`${E}/datasets/FUELHH/stream?settlementDateFrom=${sday(now - 3 * DAY)}&settlementDateTo=${sday(now)}&fuelType=WIND`, { timeout: 45000, tries: 2 }));
}

/* ---------------- daily aggregates ---------------- */

// NESO's DATETIME may be stamped in UK local time or UTC; check against Elexon's interconnector imports, which are UTC
function detectShift(mixRows, ic) {
  const test = summer => {
    const score = {};
    for (const off of [-60, -30, 0, 30, 60]) {
      let s = 0, n = 0;
      for (const r of mixRows) {
        const t = Date.parse(r.DATETIME + "Z");
        if (isBST(t) !== summer) continue;
        const e = ic.get(t + off * 6e4); if (!e) continue;
        s += Math.abs(r.IMPORTS - e.imp); n++;
      }
      score[off] = n > 200 ? s / n : null;
    }
    const ok = Object.entries(score).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1]);
    return { best: ok.length ? +ok[0][0] : null, score };
  };
  return { summer: test(true), winter: test(false) };
}

const mixTime = (r, shift) => { const t = Date.parse(r.DATETIME + "Z"); return t + ((isBST(t) ? shift.summer : shift.winter) || 0) * 6e4; };
function emptyRec() { return {}; }
function upd(rec, key, v, t, max = true) {
  if (v == null || !isFinite(v)) return;
  const cur = rec[key];
  if (!cur || (max ? v > cur[0] : v < cur[0])) rec[key] = [r1(v), t];
}

function buildDays(mixRows, ic, dem, mid, bat, shift) {
  const days = new Map();
  const seen = new Set();
  for (const r of mixRows) {
    const t = mixTime(r, shift);
    if (seen.has(t)) continue; seen.add(t);
    const d = dkey(t);
    const mw = {
      gas: +r.GAS || 0, coal: +r.COAL || 0, nuclear: +r.NUCLEAR || 0, wind: (+r.WIND || 0) + (+r.WIND_EMB || 0), windEmb: +r.WIND_EMB || 0,
      hydro: +r.HYDRO || 0, biomass: +r.BIOMASS || 0, other: +r.OTHER || 0, solar: +r.SOLAR || 0, storage: +r.STORAGE || 0
    };
    const impG = +r.IMPORTS || 0, dom = (+r.GENERATION || 0) - impG;
    // skip broken half-hours: GB generation never drops below about 10 GW, and gas and nuclear are never both off
    if (dom < 8000 || mw.gas + mw.nuclear < 500) continue;
    const f = ic.get(t), exp = f ? f.exp : 0, net = impG - exp, den = dom + Math.max(0, net);
    const ci = +r.CARBON_INTENSITY, dm = dem.get(t), pr = mid.get(t), b = bat.hh && t <= now ? bat.hh.get(t) : null;
    let a = days.get(d);
    if (!a) { a = { d, n: 0, s: Object.fromEntries([...FUELS, "dom", "impG", "exp", "net"].map(k => [k, 0])), ci: [0, 0, 1e9, -1e9], dem: [0, 0, 1e9, -1e9], mid: [0, 0, 1e9, -1e9], cib: [0, 0, 0, 0, 0], bat: null, icMissing: 0, rec: emptyRec() }; days.set(d, a); }
    a.n++;
    FUELS.forEach(k => a.s[k] += mw[k]);
    a.s.dom += dom; a.s.impG += impG; a.s.exp += exp; a.s.net += net;
    if (!f) a.icMissing++;
    const acc = (arr, v) => { if (v == null || !isFinite(v)) return; arr[0] += v; arr[1]++; arr[2] = Math.min(arr[2], v); arr[3] = Math.max(arr[3], v); };
    acc(a.ci, ci); acc(a.dem, dm); acc(a.mid, pr);
    if (isFinite(ci)) a.cib[ci < 40 ? 0 : ci < 120 ? 1 : ci < 200 ? 2 : ci < 290 ? 3 : 4]++;
    if (b) { a.bat = a.bat || { dis: 0, chg: 0, n: 0, pd: 0, pc: 0 }; a.bat.dis += b.dis / 2; a.bat.chg += b.chg / 2; a.bat.n++; a.bat.pd = Math.max(a.bat.pd, b.dis - b.chg); a.bat.pc = Math.max(a.bat.pc, b.chg - b.dis); }
    const ren = mw.wind + mw.solar + mw.hydro + mw.biomass;
    const rec = a.rec;
    upd(rec, "windMW", mw.wind, t); upd(rec, "windPct", mw.wind / den * 100, t); upd(rec, "solarMW", mw.solar, t);
    upd(rec, "renPct", ren / den * 100, t); upd(rec, "lowPct", (ren + mw.nuclear) / den * 100, t); upd(rec, "fossilLo", (mw.gas + mw.coal) / den * 100, t, false);
    upd(rec, "ciLo", ci, t, false); upd(rec, "ciHi", ci, t);
    if (dm != null) { upd(rec, "demHi", dm, t); upd(rec, "demLo", dm, t, false); }
    if (pr != null) { upd(rec, "priceHi", pr, t); upd(rec, "priceLo", pr, t, false); if (pr < 0) rec.neg = (rec.neg || 0) + 1; }
    if (f) upd(rec, "exportHi", -net, t);
    if (b) upd(rec, "batHi", b.dis - b.chg, t);
  }
  const out = {};
  days.forEach(a => {
    const n = a.n, avg = arr => arr[1] ? [r0(arr[0] / arr[1]), r0(arr[2]), r0(arr[3])] : null;
    const mw = {}; Object.keys(a.s).forEach(k => mw[k] = r0(a.s[k] / n));
    out[a.d] = {
      d: a.d, n, mw, ci: avg(a.ci), dem: avg(a.dem), mid: a.mid[1] ? [r1(a.mid[0] / a.mid[1]), r1(a.mid[2]), r1(a.mid[3])] : null,
      cib: a.cib, bat: a.bat && a.bat.n >= 40 ? { dis: r0(a.bat.dis), chg: r0(a.bat.chg), pd: r0(a.bat.pd), pc: r0(a.bat.pc), n: a.bat.n } : null,
      icMissing: a.icMissing, rec: a.rec
    };
  });
  return out;
}

// shares of GB use with imports counted net of exports over the period
function shares(mw) {
  const den = mw.dom + Math.max(0, mw.net) || 1, o = {};
  ["gas", "coal", "nuclear", "wind", "hydro", "biomass", "other", "solar", "storage"].forEach(k => o[k] = mw[k] / den * 100);
  o.imports = Math.max(0, mw.net) / den * 100;
  return o;
}

function combine(list) {
  const N = list.reduce((a, x) => a + x.n, 0);
  const mw = {};
  Object.keys(list[0].mw).forEach(k => mw[k] = r0(list.reduce((a, x) => a + x.mw[k] * x.n, 0) / N));
  const band = key => {
    const l = list.filter(x => x[key]);
    if (!l.length) return null;
    const w = l.reduce((a, x) => a + x.n, 0);
    const v = l.reduce((a, x) => a + x[key][0] * x.n, 0) / w;
    return [key === "mid" ? r1(v) : r0(v), Math.min(...l.map(x => x[key][1])), Math.max(...l.map(x => x[key][2]))];
  };
  const cib = [0, 1, 2, 3, 4].map(i => list.reduce((a, x) => a + (x.cib ? x.cib[i] : 0), 0));
  const bl = list.filter(x => x.bat);
  const bat = bl.length ? { dis: bl.reduce((a, x) => a + x.bat.dis, 0), chg: bl.reduce((a, x) => a + x.bat.chg, 0), days: bl.length } : null;
  return { n: N, mw, ci: band("ci"), dem: band("dem"), mid: band("mid"), cib, bat };
}

function weekKey(d) {
  const t = Date.parse(d + "T12:00:00Z"), wd = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - wd * DAY).toISOString().slice(0, 10);
}

function records(daysArr) {
  const reduce = list => {
    const rec = {};
    const maxKeys = ["windMW", "windPct", "solarMW", "renPct", "lowPct", "ciHi", "demHi", "priceHi", "exportHi", "batHi"];
    const minKeys = ["fossilLo", "ciLo", "demLo", "priceLo"];
    list.forEach(x => {
      maxKeys.forEach(k => { const v = x.rec[k]; if (v && (!rec[k] || v[0] > rec[k][0])) rec[k] = v; });
      minKeys.forEach(k => { const v = x.rec[k]; if (v && (!rec[k] || v[0] < rec[k][0])) rec[k] = v; });
      rec.neg = (rec.neg || 0) + (x.rec.neg || 0);
      const full = x.n >= 46;
      if (!full) return;
      const s = shares(x.mw);
      const dayMax = (k, v) => { if (!rec[k] || v > rec[k][0]) rec[k] = [r1(v), x.d]; };
      const dayMin = (k, v) => { if (!rec[k] || v < rec[k][0]) rec[k] = [r1(v), x.d]; };
      if (x.ci) dayMin("greenDay", x.ci[0]);
      dayMax("windDay", x.mw.wind); dayMax("solarDay", x.mw.solar);
      dayMax("renDay", s.wind + s.solar + s.hydro + s.biomass);
      if (x.dem) dayMax("demDay", x.dem[0]);
    });
    rec.days = list.length;
    return rec;
  };
  const by = (keyFn) => { const m = new Map(); daysArr.forEach(x => { const k = keyFn(x.d); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; };
  const months = {}, years = {};
  by(d => d.slice(0, 7)).forEach((l, k) => months[k] = reduce(l));
  by(d => d.slice(0, 4)).forEach((l, k) => years[k] = reduce(l));
  return { months, years, all: reduce(daysArr), from: daysArr[0]?.d, to: daysArr[daysArr.length - 1]?.d };
}

/* ---------------- main ---------------- */

const meta = { built: iso(now), ok: {}, errors: {} };
async function step(name, fn) {
  try { const v = await fn(); meta.ok[name] = true; return v; }
  catch (e) { meta.ok[name] = false; meta.errors[name] = String(e).slice(0, 300); log("FAILED", name, e); return null; }
}

// Save regional price history first so it is available even if a later grid-data source fails.
await step("agilePrices", () => buildAgilePrices());

// Keep the outlook independent of slower historic-grid and battery rebuilds.
const [ef, du, wf, wa, generationActual] = await Promise.all([
  step("embeddedForecast", embeddedForecast),
  step("demandUpdate", demandUpdate),
  step("windForecast", windForecast),
  step("windOutturn", windOutturn),
  step("generationOutturn", () => get(`${E}/datasets/FUELHH/stream?settlementDateFrom=${sday(now - 8 * DAY)}&settlementDateTo=${sday(now)}`, { timeout: 60000, tries: 2 }).then(rows))
]);
{
  // embedded wind and solar for the live views: NESO's outturn estimate where it exists, then its forecast
  const m = new Map();
  if (du) du.forEach(r => { if (r.t >= now - 8 * DAY && r.t <= now + 3 * DAY) m.set(r.t, [r.t, r0(r.wind), r0(r.solar), r.act ? 1 : 0]); });
  if (ef) ef.forEach(r => { if (r.t <= now + 3 * DAY) { const e = m.get(r.t); if (!e || !e[3]) m.set(r.t, [r.t, r0(r.wind), r0(r.solar), 0]); } });
  const cap = (ef && ef[0]) ? { wind: ef[0].capW, solar: ef[0].capS } : du && du.length ? { wind: du[du.length - 1].capW, solar: du[du.length - 1].capS } : null;
  if (m.size) await write("embedded.json", { built: meta.built, cap, hh: [...m.values()].sort((a, b) => a[0] - b[0]) });

  await step("outlook", async () => write("forecast.json", assembleOutlook({
    now, windActual: wa || [], demandUpdate: du || [], embeddedForecast: ef || [], windForecast: wf || [],
    previous: await readJSON("forecast.json", null), cap, embeddedPublished: ef?.published || null
  })));
}


// Save current generation before the older, independent historic-grid rebuild.
await step("generation", async () => {
  if (!generationActual || !du) throw new Error("Generation source unavailable");
  await write("generation.json", snapshotFromElexon(generationActual, du, now));
});

// bump VERSION whenever the way days are built changes, so the whole history is rebuilt on the next run
const VERSION = 2;
let state = await readJSON("daily.json", null);
if (!state || state.v !== VERSION) state = { v: VERSION, shift: state && state.shift || null, days: {} };
const today = dkey(now);
const window = [];
for (let k = KEEP; k >= 0; k--) window.push(dkey(now - k * DAY));
const uniqWindow = [...new Set(window)];
// fetch from the first day never fetched before (gaps in NESO's data are tried once, not every hour)
const tried = d => state.tried && d >= state.tried[0] && d <= state.tried[1];
let fromDay = uniqWindow.find(d => !state.days[d] && !tried(d)) || today;
const recent = dkey(now - REBUILD * DAY);
if (fromDay > recent) fromDay = recent;
const fromT = ukMidnight(fromDay) - 2 * 36e5;
log("rebuilding from", fromDay, "| stored days", Object.keys(state.days).length);

const [mixRows, ic, dem, mid, bat] = await Promise.all([
  step("nesoMix", () => nesoMix(fromT)),
  step("interconnectors", () => icFlows(fromT)),
  step("demand", () => demand(fromT)),
  step("prices", () => prices(fromT)),
  step("batteries", () => batteries())
]);

if (mixRows && mixRows.length && ic) {
  if (!state.shift || mixRows.length > 5000) {
    const s = detectShift(mixRows, ic);
    log("NESO time check", JSON.stringify(s));
    const prev = state.shift || { summer: 0, winter: 0 };
    state.shift = { summer: s.summer.best ?? prev.summer, winter: s.winter.best ?? prev.winter };
  }
  state.tried = [state.tried && state.tried[0] < fromDay ? state.tried[0] : fromDay, today];
  const built = buildDays(mixRows, ic, dem || new Map(), mid || new Map(), bat || {}, state.shift || { summer: 0, winter: 0 });
  Object.values(built).forEach(x => {
    if (x.d < fromDay) return;
    const old = state.days[x.d];
    if (!x.bat && old && old.bat) x.bat = old.bat;   // battery history only reaches back 7 days; keep older days
    state.days[x.d] = x;
  });
}
// keep the window only
const keepFrom = uniqWindow[0];
Object.keys(state.days).forEach(d => { if (d < keepFrom) delete state.days[d]; });
const daysArr = Object.values(state.days).sort((a, b) => a.d < b.d ? -1 : 1);
meta.days = daysArr.length; meta.first = daysArr[0]?.d; meta.last = daysArr[daysArr.length - 1]?.d;
meta.mixLatest = mixRows && mixRows.length ? iso(mixTime(mixRows[0], state.shift || {})) : null;
meta.shift = state.shift;
await write("daily.json", state);

if (daysArr.length) {
  await write("generation-days.json", mergeGenerationDays(daysArr, await readJSON("generation.json", null), now));
  // compact daily file for the 30-day views (last 400 days covers this month and the same month a year ago)
  const lite = x => ({ d: x.d, n: x.n, mw: x.mw, ci: x.ci, dem: x.dem, mid: x.mid, cib: x.cib, bat: x.bat ? [x.bat.dis, x.bat.chg] : null });
  await write("days.json", { built: meta.built, days: daysArr.slice(-400).map(lite) });
  // weekly file for the 1-year views, weeks starting Monday
  const wk = new Map();
  daysArr.forEach(x => { const k = weekKey(x.d); if (!wk.has(k)) wk.set(k, []); wk.get(k).push(x); });
  const weeks = [...wk.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([w, l]) => ({ w, days: l.length, ...combine(l) }));
  await write("weekly.json", { built: meta.built, weeks });
  await write("records.json", { built: meta.built, ...records(daysArr) });
}

if (bat) {
  const cut = now - 7 * DAY;
  const hh = [...bat.hh.entries()].filter(([t]) => t >= cut && t <= now).sort((a, b) => a[0] - b[0]).map(([t, e]) => [t, r0(e.dis), r0(e.chg)]);
  await write("battery.json", { built: meta.built, units: bat.units, capMW: r0(bat.capMW), hh });
}


await write("meta.json", meta);
log("done", JSON.stringify(meta.ok));




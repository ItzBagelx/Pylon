export const HH = 1800000, HOUR = 3600000, DAY = 86400000;
export const FUELS = ["nuclear", "biomass", "hydro", "wind", "solar", "storage", "other", "gas"];
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" });
export const dateKey = t => dateFmt.format(new Date(t));
const offsetDate = (key, days) => new Date(Date.parse(key + "T12:00:00Z") + days * DAY).toISOString().slice(0, 10);
export function midnight(key) {
  const t = Date.parse(key + "T00:00:00Z");
  return [t, t - HOUR, t + HOUR].find(x => dateKey(x) === key && hourFmt.format(new Date(x)) === "00") ??
    [t, t - HOUR, t + HOUR].find(x => dateKey(x) === key && Number(hourFmt.format(new Date(x))) === 0);
}
const number = x => x !== null && x !== "" && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : null;

// Metered transmission output plus reported (not forecast) embedded wind/solar.
export function snapshotFromElexon(rows, embedded, now = Date.now()) {
  const cut = Math.floor(now / HH) * HH, byTime = new Map();
  const emb = new Map(embedded.filter(r => Number.isFinite(r.wind) && r.wind >= 0 && Number.isFinite(r.solar) && r.solar >= 0).sort((a, b) => Number(a.act) - Number(b.act)).map(r => [r.t, r]));
  for (const row of rows) {
    const t = Date.parse(row.startTime), fuel = row.fuelType;
    if (!Number.isFinite(t) || t % HH || t < cut - 8 * DAY || t >= cut || typeof fuel !== "string" || fuel.startsWith("INT") || number(row.generation) === null || (Number(row.generation) < 0 && fuel !== "PS")) continue;
    const fuels = byTime.get(t) || new Map(), previous = fuels.get(fuel);
    if (!previous || Date.parse(row.publishTime) >= Date.parse(previous.publishTime)) fuels.set(fuel, row);
    byTime.set(t, fuels);
  }
  const hh = [], estimates = [];
  for (const [t, values] of byTime) {
    const e = emb.get(t);
    if (!e || ["CCGT", "NUCLEAR", "BIOMASS", "WIND", "NPSHYD", "PS", "OTHER"].some(f => !values.has(f))) continue;
    const mw = Object.fromEntries(FUELS.map(f => [f, 0]));
    for (const [fuel, row] of values) {
      const key = { CCGT: "gas", OCGT: "gas", NUCLEAR: "nuclear", BIOMASS: "biomass", WIND: "wind", NPSHYD: "hydro", PS: "storage" }[fuel] || "other";
      mw[key] += Math.max(0, Number(row.generation));
    }
    mw.wind += e.wind; mw.solar = e.solar;
    const domestic = Object.values(mw).reduce((a, b) => a + b, 0);
    if (domestic >= 8000) { hh.push([t, domestic, ...FUELS.map(k => mw[k])]); if (!e.act) estimates.push(t); }
  }
  hh.sort((a, b) => a[0] - b[0]);
  if (!hh.length) throw new Error("No complete reported generation half-hours; retain the previous snapshot");
  return { v: 1, built: new Date(now).toISOString(), latest: new Date(hh.at(-1)[0]).toISOString(), fuels: FUELS, source: "Elexon FUELHH + NESO embedded wind/solar; forecast embedded periods flagged", estimates, hh };
}

export function mergeGenerationDays(historicDays, snapshot, now = Date.now()) {
  const byDay = new Map((historicDays || []).filter(r => r.mw?.dom > 0).map(r => [r.d, { d: r.d, n: r.n, mw: Object.fromEntries(["dom", ...FUELS].map(k => [k, k === "other" ? (r.mw.other || 0) + (r.mw.coal || 0) : r.mw[k]])) }]));
  const recent = new Map(), estimates = new Set(snapshot?.estimates || []);
  for (const row of snapshot?.hh || []) {
    const d = dateKey(row[0]); if (d >= dateKey(now)) continue;
    const list = recent.get(d) || []; list.push(row); recent.set(d, list);
  }
  for (const [d, rows] of recent) {
    const old = byDay.get(d); if (old && old.n > rows.length) continue;
    const mw = { dom: rows.reduce((s, r) => s + r[1], 0) / rows.length };
    FUELS.forEach((k, i) => mw[k] = rows.reduce((s, r) => s + r[i + 2], 0) / rows.length);
    byDay.set(d, { d, n: rows.length, mw, estimated: rows.some(r => estimates.has(r[0])) });
  }
  const days = [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-400);
  return { built: new Date(now).toISOString(), source: "NESO historic mix; recent days Elexon with NESO embedded outturn", days };
}

function aggregate(rows, start, end, expected) {
  const n = rows.reduce((s, r) => s + r.n, 0);
  if (!n) return { t: new Date(start), end, n: 0, expected, total: null, v: null, lo: null, hi: null };
  const total = rows.reduce((s, r) => s + r.total * r.n, 0) / n;
  const v = Object.fromEntries(FUELS.map(k => [k, rows.reduce((s, r) => s + r.v[k] * r.n, 0) / n]));
  return { t: new Date(start), end, n, expected, total, v, estimated: rows.some(r => r.estimated), lo: Math.min(...rows.map(r => r.total)), hi: Math.max(...rows.map(r => r.total)) };
}
function finish(points, ms, source) {
  if (!points.some(p => p.n)) throw new Error("No generation readings for this period");
  const valid = points.filter(p => p.n), n = valid.reduce((s, p) => s + p.n, 0);
  points.meta = {
    ms, built: source.built, latest: source.latest || new Date(valid.at(-1).end - HH).toISOString(),
    avgTotal: valid.reduce((s, p) => s + p.total * p.n, 0) / n,
    avg: Object.fromEntries(FUELS.map(k => [k, valid.reduce((s, p) => s + p.v[k] * p.n, 0) / n])),
    coverage: n / points.reduce((s, p) => s + p.expected, 0), n,
    from: +points[0].t, to: points.at(-1).end
  };
  return points;
}

export function recentSeries(snapshot, hours, now = Date.now()) {
  if (![24, 168].includes(hours)) throw new Error("Unsupported short generation range");
  if (snapshot.v !== 1 || !Array.isArray(snapshot.hh) || FUELS.some((f, i) => snapshot.fuels?.[i] !== f)) throw new Error("Invalid generation snapshot");
  const ms = hours === 24 ? HH : HOUR, to = Math.floor(now / ms) * ms, from = to - hours * HOUR;
  const byTime = new Map(), estimates = new Set(snapshot.estimates || []);
  for (const row of snapshot.hh) {
    if (!Array.isArray(row) || row.length !== FUELS.length + 2 || !row.every(Number.isFinite) || row[0] % HH || row[0] < from || row[0] >= to) continue;
    if (row[1] <= 0 || row.slice(2).some(x => x < 0)) continue;
    byTime.set(row[0], { n: 1, estimated: estimates.has(row[0]), total: row[1] / 1000, v: Object.fromEntries(FUELS.map((f, i) => [f, row[i + 2] / 1000])) });
  }
  const points = [];
  for (let t = from; t < to; t += ms) {
    const rows = [];
    for (let x = t; x < t + ms; x += HH) if (byTime.has(x)) rows.push(byTime.get(x));
    // A one-half-hour gap must not become an invented whole-hour average.
    points.push(aggregate(rows.length === ms / HH ? rows : [], t, t + ms, ms / HH));
  }
  return finish(points, ms, snapshot);
}

export function dailySeries(source, hours, now = Date.now()) {
  if (![720, 8760].includes(hours)) throw new Error("Unsupported long generation range");
  const count = hours === 720 ? 30 : 365, toKey = dateKey(now), fromKey = offsetDate(toKey, -count);
  const byDay = new Map();
  for (const row of source.days || []) {
    if (row.d < fromKey || row.d >= toKey || !Number.isFinite(row.n) || row.n <= 0 || !Number.isFinite(row.mw?.dom) || row.mw.dom <= 0) continue;
    const mw = { ...row.mw, other: (row.mw.other ?? 0) + (row.mw.coal ?? 0) };
    if (FUELS.some(k => !Number.isFinite(mw[k]) || mw[k] < 0)) continue;
    const start = midnight(row.d), end = midnight(offsetDate(row.d, 1)), expected = (end - start) / HH;
    if (row.n > expected) continue;
    byDay.set(row.d, { n: row.n, estimated: !!row.estimated, total: mw.dom / 1000, v: Object.fromEntries(FUELS.map(f => [f, mw[f] / 1000])) });
  }
  const days = [];
  for (let i = 0; i < count; i++) {
    const key = offsetDate(fromKey, i), start = midnight(key), end = midnight(offsetDate(key, 1));
    days.push(aggregate(byDay.has(key) ? [byDay.get(key)] : [], start, end, (end - start) / HH));
  }
  if (hours === 720) return finish(days, DAY, source);
  const weeks = [];
  // Seven-calendar-day averages; the final shorter bucket is labelled in tooltips.
  for (let i = 0; i < days.length; i += 7) {
    const group = days.slice(i, i + 7);
    weeks.push(aggregate(group.filter(p => p.n), +group[0].t, group.at(-1).end, group.reduce((s, p) => s + p.expected, 0)));
  }
  return finish(weeks, 7 * DAY, source);
}

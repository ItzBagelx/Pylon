import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.octopus.energy/v1";
const REGIONS = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P"];
const FALLBACK = "AGILE-24-10-01";
const DAY = 864e5, HH = 18e5;
const ukDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const ukHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" });
const shift = (key, n) => new Date(Date.parse(key + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
const midnight = key => {
  const utc = Date.parse(key + "T00:00:00Z");
  return utc - Number(ukHour.format(new Date(utc))) * 36e5;
};

async function json(url, fetchImpl) {
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const response = await fetchImpl(url, { signal: ctl.signal, headers: { "User-Agent": "pylon-dashboard/1.0" } });
      if (!response.ok) throw new Error(`Octopus HTTP ${response.status}`);
      return await response.json();
    } catch (e) { error = e; }
    finally { clearTimeout(timer); }
  }
  throw error;
}

export async function buildAgilePrices({ outDir = "data", now = Date.now(), fetchImpl = fetch } = {}) {
  const today = ukDate.format(new Date(now));
  // One spare historic day covers the build crossing UK midnight; future slots also back up live views.
  const from = midnight(shift(today, -31)), to = midnight(shift(today, 2));
  const catalogue = await json(`${API}/products/?brand=OCTOPUS_ENERGY&is_variable=true&page_size=100`, fetchImpl).catch(() => null);
  const products = (catalogue?.results || []).filter(p => /^AGILE-/.test(p.code) && !/OUTGOING|FLEX/.test(p.code) && !p.is_business && p.direction !== "EXPORT" && !p.available_to);
  products.sort((a, b) => String(b.available_from).localeCompare(String(a.available_from)));
  const product = products[0]?.code || FALLBACK;
  await fs.mkdir(outDir, { recursive: true });
  let cursor = 0;
  const written = [], failed = [];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < REGIONS.length) {
      const region = REGIONS[cursor++];
      try {
        const base = `${API}/products/${product}/electricity-tariffs/E-1R-${product}-${region}/standard-unit-rates/`;
        const query = new URLSearchParams({ period_from: new Date(from).toISOString(), period_to: new Date(to).toISOString(), page_size: "1500" });
        let url = base + "?" + query, pages = 0;
        const rates = new Map();
        while (url) {
          if (++pages > 10 || !url.startsWith(base)) throw new Error("Invalid Octopus pagination");
          const result = await json(url, fetchImpl);
          if (!Array.isArray(result.results)) throw new Error("Invalid Octopus rate response");
          for (const rate of result.results) {
            if (rate.payment_method && rate.payment_method !== "DIRECT_DEBIT") continue;
            const t = Date.parse(rate.valid_from), end = rate.valid_to ? Date.parse(rate.valid_to) : t + HH;
            if (!Number.isFinite(t) || !Number.isFinite(end) || end <= t || end <= from || t >= to || typeof rate.value_inc_vat !== "number" || !Number.isFinite(rate.value_inc_vat)) continue;
            rates.set(t, [t, end, rate.value_inc_vat]);
          }
          url = result.next;
        }
        const hh = [...rates.values()].sort((a, b) => a[0] - b[0]);
        if (!hh.length || hh[0][0] > midnight(shift(today, -30)) || hh.at(-1)[1] < midnight(today)) throw new Error("Incomplete history coverage");
        const file = path.join(outDir, `agile-${region}.json`);
        const header = { built: new Date(now).toISOString(), product, region, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
        const text = JSON.stringify(header).slice(0, -1) + ',"hh":[\n' + hh.map(row => JSON.stringify(row)).join(',\n') + '\n]}\n';
        await fs.writeFile(file + ".tmp", text);
        await fs.rename(file + ".tmp", file);
        written.push(region);
        console.log("Agile history", region, hh.length, "half-hours");
      } catch (e) {
        failed.push(region);
        console.warn("Keeping previous Agile history for", region, String(e));
      }
    }
  }));
  if (failed.length) throw new Error(`Agile history update failed for ${failed.join(", ")}; existing files retained`);
  return { product, regions: written.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildAgilePrices();
}

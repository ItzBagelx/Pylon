const HH = 18e5, HOUR = 36e5, DAY = 864e5;
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

// Flags: 1 = large-farm wind forecast; 2 = embedded wind/solar forecast.
// Keep explicit missing half-hours so the chart cannot compress time or invent zero output.
export function assembleOutlook({ now, windActual = [], demandUpdate = [], embeddedForecast = [], windForecast = [], previous = null, cap = null, embeddedPublished = null }) {
  const cut = Math.floor(now / HH) * HH, from = cut - 2 * DAY;
  const actual = new Map(), embedded = new Map(), old = new Map();
  for (const row of previous?.past || []) if (row[0] >= from && !(row[4] & 1)) old.set(row[0], row);
  for (const row of windActual) {
    const t = Date.parse(row.startTime);
    if (row.fuelType !== "WIND" || !Number.isFinite(t) || t < from || t + HH > now || number(row.generation) == null) continue;
    const prior = actual.get(t);
    if (!prior || row.publishTime > prior.publishTime) actual.set(t, row);
  }
  for (const row of demandUpdate) {
    const prior = embedded.get(row.t);
    if (Number.isFinite(row.t) && (!prior || row.act || prior.forecast)) embedded.set(row.t, { ...row, forecast: !row.act });
  }
  for (const row of embeddedForecast) {
    const prior = embedded.get(row.t);
    if (Number.isFinite(row.t) && (!prior || prior.forecast)) embedded.set(row.t, { ...row, forecast: true });
  }
  const windPublished = windForecast.reduce((latest, row) => row.pub > latest ? row.pub : latest, "");
  const forecast = new Map(windForecast.filter(row => row.pub === windPublished && Number.isFinite(row.t) && number(row.mw) != null).map(row => [row.t, row]));
  const forecastHours = [...forecast.keys()].sort((a, b) => a - b);
  const embeddedTimes = [...embedded.keys()].filter(t => embedded.get(t).forecast);
  const to = Math.min(cut + 3 * DAY, Math.max(...forecastHours, cut - HOUR) + HOUR, Math.max(...embeddedTimes, cut - HH) + HH);
  const past = [], fut = [];
  for (let t = from; t < Math.max(cut, to); t += HH) {
    const e = embedded.get(t), prior = old.get(t);
    let w = null, flags = e ? (e.forecast ? 2 : 0) : (prior?.[4] & 2 || 0);
    if (t < cut) w = number(actual.get(t)?.generation) ?? number(prior?.[1]);
    else {
      // WINDFOR is hourly. A value covers its hour, never an hour beyond the last forecast.
      const hour = forecastHours.findLast(hour => hour <= t);
      if (hour != null && t < hour + HOUR) w = number(forecast.get(hour).mw);
      flags |= 1;
    }
    const ew = e ? number(e.wind) : number(prior?.[2]);
    const solar = e ? number(e.solar) : number(prior?.[3]);
    (t < cut ? past : fut).push([t, w, ew, solar, flags]);
  }
  if (!fut.some(row => row.slice(1, 4).every(value => value != null))) throw new Error("No complete wind and solar forecast; previous outlook retained");
  return { v: 2, built: new Date(now).toISOString(), windPublished: windPublished || null, embeddedPublished, past, fut, cap };
}

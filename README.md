# Pylon

A live dashboard for Great Britain's electricity grid: generation mix, net imports, batteries,
wind and solar forecasts, demand, Octopus Agile and Tracker prices, wholesale prices, records and installed capacity.

Live site: https://pylongrid.co.uk

## How it works

- `index.html` is the whole site. Live panels call the public APIs straight from the browser every five minutes.
- `scripts/build-data.mjs` runs every hour in GitHub Actions (`.github/workflows/pages.yml`). It writes small files
  to `data/` that the site uses for its 30-day and 1-year views, records, battery activity, embedded wind and forecasts,
  then deploys the site to GitHub Pages.

| File | What it holds |
| --- | --- |
| `data/days.json` | Daily averages and highs/lows for the last 400 days |
| `data/weekly.json` | Weekly summaries for two years (1-year views and last-year comparisons) |
| `data/records.json` | Monthly, yearly and two-year records |
| `data/battery.json` | Battery charging and output by half-hour, last 7 days |
| `data/embedded.json` | NESO's embedded wind and solar estimates and forecast |
| `data/forecast.json` | Wind and solar forecast, plus the last 48 hours |
| `data/daily.json` | The builder's full state (two years of days) |

## Price views

- Agile shows published half-hourly rates for the next 24 hours or today and tomorrow.
- Regional Agile history is saved by `scripts/build-agile.mjs` during each data build, so long views can load without a live browser API request. Failed builds retain the previous files; the browser can fall back to the public API.
- Its 7-day history uses hourly averages; its 30-day history uses daily averages. Both cover complete UK calendar days
  before today. Shaded bands retain half-hourly lows and highs, and missing periods remain gaps.
- Tracker has a separate daily-price chart, 7-day and 30-day history, today/tomorrow rates when published, and a tariff-version selector.
- Rates include VAT and exclude standing charges. Comparisons use the same available hours with equal consumption;
  they are not personalised bill estimates. UK clock changes are included in duration-weighted averages.

## Battery coverage

The battery chart shows published physical notifications (planned positions), not settled metered output or a whole-fleet estimate.
The builder identifies units by registered names and supplements them with additional directly connected or embedded BM units
verified against NESO's battery classifications in `scripts/battery-units.json`. Counts refer to BM units, not separate sites.
Registered export capacity is the sum for the identified units; it should not be treated as a verified percentage of total operational capacity.

## Data sources

NESO Carbon Intensity API (CC BY 4.0), NESO Data Portal (historic generation mix, demand data, embedded forecasts),
Elexon Insights Solution, and the Octopus Energy API. Capacity figures from DESNZ, EDF, Modo Energy and RenewableUK.
Not affiliated with NESO, Elexon or Octopus Energy.

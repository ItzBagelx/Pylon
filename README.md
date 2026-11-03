# Pylon

A live dashboard for Great Britain's electricity grid: generation mix, net imports, carbon intensity, batteries,
wind and solar forecasts, demand, Octopus Agile and Tracker prices, wholesale prices, records and installed capacity.

Live site: https://itzbagelx.github.io/Pylon/

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

## Data sources

NESO Carbon Intensity API (CC BY 4.0), NESO Data Portal (historic generation mix, demand data, embedded forecasts),
Elexon Insights Solution, and the Octopus Energy API. Capacity figures from DESNZ, EDF, Modo Energy and RenewableUK.
Not affiliated with NESO, Elexon or Octopus Energy.

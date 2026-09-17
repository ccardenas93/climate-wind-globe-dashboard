# Climate Wind Globe Dashboard

An interactive 3D globe that renders the atmosphere as a physical flow rather
than a picture: thousands of tracer particles are advected across the sphere by
the real wind field, cloud cover drifts as a layered haze, and the oceans are
painted with measured sea surface temperature.

All data comes from [Open-Meteo](https://open-meteo.com/). No API key is
required.

## How it works

### The wind field

The globe is sampled on a global grid at **8°** resolution (22 × 45 = 990
cells), and every cell is fetched with the eastward (`u`) and northward (`v`)
components of the 10 m wind, plus wind speed, direction, cloud cover and air
temperature, for **120 hours** (2 days of history and 3 days of forecast).

Those samples are the only thing driving the animation. Each frame the
particles are stepped through

```
dLat = v / R          * dt
dLon = u / (R cos φ)  * dt
```

with `u` and `v` bilinearly interpolated from the grid, longitude wrapping at
the date line and latitude scaled by `cos φ` so that a wind blowing east covers
the same ground distance at any latitude. A fixed 1/45 s timestep keeps the flow
stable independently of frame rate.

### The layers

| Layer | Source | Notes |
| --- | --- | --- |
| Wind tracers | forecast API | Particles advected by the sampled `u`/`v` |
| Cloud mist | forecast API | Three drifting shells driven by cloud cover |
| Sea temperature | marine API | Falls back to the ERA5 archive |
| Timeline | forecast API | Scrubs the 120-hour window |

### Data sources and fallbacks

The freshest ocean data comes from the marine endpoint, but it is the most
aggressively rate-limited of the three services. When it is unavailable the app
falls back to the **ERA5 reanalysis archive**, which answers the same question
from a separate quota and lags real time by about a week. The interface says
which source is in use, because a reanalysis and a forecast are not the same
thing.

Requests are batched — hundreds of coordinates travel in a single call — but
they are still queued through a small worker pool, with backoff on `429`
responses and a shortened retry budget on the marine path so a rate limit
fails over to ERA5 quickly instead of stalling.

### Caching

A full field is roughly 3 MB, so it is cached in `localStorage` for 30 minutes.
Reloading the page then costs no requests at all. Stale, corrupt or
wrong-version entries are discarded on read.

## Features

- Particles physically advected by real `u`/`v` wind components
- Cloud-cover haze on stacked shells, giving the atmosphere depth
- Sea surface temperature mapped onto the oceans
- ERA5 fallback so the ocean layer survives a rate limit
- 120-hour time scrubber with play/pause and variable speed
- City search with geocoding, plus quick-pick presets
- Live conditions, 7-day outlook and per-city field readouts

## Tech stack

React 18, Vite 5, React Three Fiber, drei, three.js (custom GLSL shaders),
Framer Motion.

## Getting started

```bash
npm install
npm run dev
```

The dev server runs at http://localhost:5173.

The first load samples the global grid and takes a few seconds; later loads come
from the cache.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Produce a production build in `dist/` |
| `npm run preview` | Serve the production build locally |

## Deployment

Pushing to `main` triggers the GitHub Actions workflow in `.github/workflows/`,
which builds the app and publishes `dist/` to GitHub Pages. The site is served
from the `/climate-wind-globe-dashboard/` base path configured in
`vite.config.js`.

## Attribution

Weather, marine and reanalysis data by [Open-Meteo](https://open-meteo.com/)
(CC BY 4.0), which in turn redistributes ECMWF IFS/AIFS, ICON and ERA5.

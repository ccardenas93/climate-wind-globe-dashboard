# Climate Wind Globe Dashboard

An interactive 3D climate dashboard that pairs a WebGL globe with live atmospheric data from the [Open-Meteo](https://open-meteo.com/) API.

## Features

- Rotating 3D globe rendered with React Three Fiber and drei
- Live current conditions: temperature, wind speed and direction, humidity, pressure
- 7-day outlook and hourly precipitation trend
- City search with geocoding, plus quick-pick presets for major cities
- Animated airflow arcs and a wind readout pinned to the selected location

## Tech stack

React 18, Vite 5, React Three Fiber, drei, three.js, Framer Motion

## Getting started

```bash
npm install
npm run dev
```

The dev server runs at http://localhost:5173.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Produce a production build in `dist/` |
| `npm run preview` | Serve the production build locally |

## Deployment

Pushing to `main` triggers the GitHub Actions workflow in `.github/workflows/`, which builds the app and publishes `dist/` to GitHub Pages. The site is served from the `/climate-wind-globe-dashboard/` base path configured in `vite.config.js`.

## Data source

Weather and geocoding data come from Open-Meteo. No API key is required.

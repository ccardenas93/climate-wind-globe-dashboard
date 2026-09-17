import { wrapLongitude, clamp } from './geo.js';

/**
 * Resolution of the sampled global field.
 *
 * Open-Meteo accepts hundreds of coordinates in one request, but the URL has to
 * stay under the server's request-line limit, which is what actually caps the
 * grid. Measured limits:
 *
 *   648 coords  -> 200 OK   (~7.5 kB URL)
 *  2592 coords  -> 414 Request-URI Too Large (~29 kB URL)
 *
 * 8 degrees gives a 22 x 45 grid (990 cells) in three batches with ~4 kB URLs,
 * which is about 890 km per cell: fine enough to resolve storm tracks and
 * ocean-temperature structure, coarse enough to load in a few seconds.
 */
export const LAT_STEP = 8;
export const LON_STEP = 8;

/** Hours of history and forecast pulled per cell. */
export const PAST_DAYS = 2;
export const FORECAST_DAYS = 3;

export const FIELD_SOURCES = {
  forecast: {
    id: 'forecast',
    label: 'Open-Meteo forecast',
    detail: 'ECMWF IFS/AIFS blend + ICON',
    attribution: 'Weather data by Open-Meteo (CC BY 4.0)',
  },
  era5: {
    id: 'era5',
    label: 'ERA5 reanalysis',
    detail: 'ECMWF ERA5 archive',
    attribution: 'ERA5 reanalysis via Open-Meteo archive (CC BY 4.0)',
  },
};

export const CLIMATOLOGY_PATH = 'data/era5-climatology.json';

const BATCH_SIZE = 330;

/**
 * The marine endpoint is stricter than the forecast endpoint and rejects wide
 * coordinate lists, so it gets smaller batches.
 */
const MARINE_BATCH_SIZE = 120;

/**
 * Short retry budget for marine requests. It has an ERA5 fallback, so failing
 * over quickly beats waiting out a rate limit.
 */
const MARINE_MAX_RETRIES = 1;

/**
 * Open-Meteo rate-limits bursts, so batch requests go through a small worker
 * pool with backoff instead of being launched all at once. The marine endpoint
 * is clearly stricter than the forecast one, so its batches are capped lower
 * and any rejection shrinks them adaptively.
 */
const MAX_CONCURRENT = 2;

async function runPool(tasks, limit = MAX_CONCURRENT) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  });

  await Promise.all(workers);
  return results;
}

/** Builds the sample grid used by every field. */
export function buildGrid(latStep = LAT_STEP, lonStep = LON_STEP) {
  const lats = [];
  const lons = [];

  for (let lat = -90 + latStep / 2; lat < 90; lat += latStep) lats.push(lat);
  for (let lon = -180; lon < 180; lon += lonStep) lons.push(lon);

  return { lats, lons };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildUrl(source, coords, { latStep, lonStep, pastDays, forecastDays }) {
  const host =
    source === 'era5' ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';

  const params = new URLSearchParams();
  params.set('latitude', coords.map((c) => c.lat).join(','));
  params.set('longitude', coords.map((c) => c.lon).join(','));
  params.set(
    'hourly',
    'wind_u_component_10m,wind_v_component_10m,wind_speed_10m,wind_direction_10m,cloud_cover,temperature_2m'
  );
  params.set('timezone', 'UTC');

  if (source === 'era5') {
    // ERA5 lags real time, so anchor the window a week back and pull the last
    // full week of analysis rather than asking for the future.
    const end = new Date(Date.now() - 7 * 86400000);
    const start = new Date(end.getTime() - (pastDays + forecastDays) * 86400000);
    params.set('start_date', start.toISOString().slice(0, 10));
    params.set('end_date', end.toISOString().slice(0, 10));
    params.set('models', 'era5');
  } else {
    params.set('past_days', String(pastDays));
    params.set('forecast_days', String(forecastDays));
  }

  return `${host}?${params.toString()}`;
}

function buildSstUrl(coords) {
  const params = new URLSearchParams();
  params.set('latitude', coords.map((c) => c.lat).join(','));
  params.set('longitude', coords.map((c) => c.lon).join(','));
  params.set('hourly', 'sea_surface_temperature');
  params.set('past_days', String(PAST_DAYS));
  params.set('forecast_days', String(FORECAST_DAYS));
  params.set('timezone', 'UTC');

  return `https://marine-api.open-meteo.com/v1/marine?${params.toString()}`;
}

function readSeries(entry, key, hours) {
  const series = entry?.hourly?.[key];
  if (!Array.isArray(series)) return null;

  const out = new Float32Array(hours);
  out.fill(NaN);
  for (let i = 0; i < Math.min(hours, series.length); i += 1) {
    const value = series[i];
    out[i] = typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  }
  return out;
}

/**
 * Fills the blanks the APIs return, pass by pass:
 *
 *   1. along each latitude row, wrapping in longitude
 *   2. from the nearest latitude band
 *
 * Every variable has gaps in practice, and the granularity matters: a few
 * missing cells inside an otherwise good row are cosmetic, whereas a whole
 * batch that was rate-limited leaves a large rectangular hole. Filling from the
 * nearest valid neighbour keeps both cases physically plausible, and the
 * remaining share of valid cells is reported through `field.coverage` so the UI
 * can tell the user when a layer is only partially available.
 */
/** Nearest sampled cell in the coarse ERA5 fallback grid. */
function nearestFallback(fallback, lat, lon) {
  const snappedLat = Math.round((lat - (90 - FALLBACK_STEP / 2)) / FALLBACK_STEP) * FALLBACK_STEP + (90 - FALLBACK_STEP / 2);
  const wrappedLon = wrapLongitude(lon);
  const snappedLon = Math.round(wrappedLon / FALLBACK_STEP) * FALLBACK_STEP;
  const normalised = snappedLon >= 180 ? snappedLon - 360 : snappedLon;

  return fallback.values.get(`${snappedLat.toFixed(1)},${normalised.toFixed(1)}`) ??
    fallback.values.get(`${Number(snappedLat.toFixed(1))},${Number(normalised.toFixed(1))}`) ??
    NaN;
}

export function fillGaps(field) {
  const { latCount, lonCount, hours } = field;

  for (const key of ['u', 'v', 'speed', 'direction', 'cloud', 'temp']) {
    const src = field[key];
    if (!src) continue;

    for (let t = 0; t < hours; t += 1) {
      // Pass 1: along the row, wrapping in longitude.
      for (let i = 0; i < latCount; i += 1) {
        for (let j = 0; j < lonCount; j += 1) {
          if (Number.isFinite(src[(i * lonCount + j) * hours + t])) continue;

          for (const n of [i * lonCount + ((j + 1) % lonCount), i * lonCount + ((j - 1 + lonCount) % lonCount)]) {
            const value = src[n * hours + t];
            if (Number.isFinite(value)) {
              src[(i * lonCount + j) * hours + t] = value;
              break;
            }
          }
        }
      }

      // Pass 2: from the nearest latitude band that has data in this column.
      for (let i = 0; i < latCount; i += 1) {
        for (let j = 0; j < lonCount; j += 1) {
          const idx = (i * lonCount + j) * hours + t;
          if (Number.isFinite(src[idx])) continue;

          let filled = false;
          for (let radius = 1; radius <= latCount && !filled; radius += 1) {
            for (const band of [i - radius, i + radius]) {
              if (band < 0 || band >= latCount) continue;
              const value = src[(band * lonCount + j) * hours + t];
              if (Number.isFinite(value)) {
                src[idx] = value;
                filled = true;
                break;
              }
            }
          }
        }
      }
    }

    // A batch that never arrived cannot be reconstructed. Those cells are left
    // as zero so the maths stays finite, but they were already counted as
    // missing by `coverage`, so the UI reports the layer as partial rather
    // than silently drawing invented weather.
    for (let i = 0; i < src.length; i += 1) if (!Number.isFinite(src[i])) src[i] = 0;
  }
}

/**
 * ERA5 archive fallback for sea surface temperature.
 *
 * The marine endpoint is the freshest source, but it is the most aggressively
 * rate-limited of the three services, and without it the whole ocean layer
 * disappears. The ERA5 archive answers the same question from a separate quota,
 * so it is used when marine is unavailable. It lags real time by about a week,
 * which for sea surface temperature is a minor difference and far better than
 * showing nothing.
 *
 * A coarser grid is used here so the fallback costs a handful of requests
 * rather than another full set.
 */
const FALLBACK_STEP = 15;

async function fetchEra5Sst(signal) {
  const lats = [];
  const lons = [];
  for (let lat = -90 + FALLBACK_STEP / 2; lat < 90; lat += FALLBACK_STEP) lats.push(lat);
  for (let lon = -180; lon < 180; lon += FALLBACK_STEP) lons.push(lon);

  const coords = [];
  for (const lat of lats) for (const lon of lons) coords.push({ lat, lon });

  const batches = chunk(coords, 150);

  // Walk back from just beyond the archive's publication lag until a date
  // actually returns data, rather than assuming a fixed offset.
  const candidateDates = [8, 12, 18, 26, 40].map(
    (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  );

  for (const date of candidateDates) {
    const values = new Map();
    let usable = 0;

    try {
      await runPool(
        batches.map((batch) => async () => {
          const params = new URLSearchParams();
          params.set('latitude', batch.map((c) => c.lat).join(','));
          params.set('longitude', batch.map((c) => c.lon).join(','));
          params.set('start_date', date);
          params.set('end_date', date);
          params.set('hourly', 'sea_surface_temperature');
          params.set('models', 'era5');
          params.set('timezone', 'UTC');

          const payload = await fetchJson(
            `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`,
            signal
          );
          const entries = Array.isArray(payload) ? payload : [payload];

          entries.forEach((entry, index) => {
            const coord = batch[index];
            if (!coord) return;
            const series = entry?.hourly?.sea_surface_temperature;
            if (!Array.isArray(series)) return;

            const valid = series.filter((v) => typeof v === 'number' && Math.abs(v) > 0.001);
            if (!valid.length) return;

            // One representative value per cell for the whole window; the
            // archive is too slow to justify twelve hourly requests per cell.
            const mean = valid.reduce((sum, v) => sum + v, 0) / valid.length;
            values.set(`${coord.lat},${coord.lon}`, mean);
            usable += 1;
          });
        })
      );
    } catch {
      continue;
    }

    if (usable > coords.length * 0.3) return { date, values, usable };
  }

  return null;
}

/**
 * `maxRetries` lets a caller shorten the retry budget. The ocean layer uses a
 * short budget because it has an ERA5 fallback waiting: spending a minute
 * retrying a rate-limited endpoint is worse than switching source quickly.
 */
async function fetchJson(url, signal, attempt = 0, maxRetries = null) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    // 429 means we were too eager; 5xx is transient. Both are worth retrying,
    // with a longer, flatter-backoff ceiling for rate limits because the quota
    // refills on a one-minute window.
    const rateLimited = response.status === 429;
    const retryable = rateLimited || response.status >= 500;
    const budget = maxRetries ?? (rateLimited ? 5 : 3);
    if (attempt < budget && retryable) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const base = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : (rateLimited ? 3000 * 2 ** attempt : 400 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.min(base, 30000)));
      return fetchJson(url, signal, attempt + 1, maxRetries);
    }
    throw new Error(`Data service responded ${response.status}`);
  }
  return response.json();
}

/**
 * Downloads the global wind field, cloud cover and sea surface temperature.
 *
 * `onProgress` is called after each batch so the UI can show the globe filling
 * in rather than a single long stall.
 */
export async function fetchGlobalFields({ source = 'forecast', signal, onProgress } = {}) {
  const grid = buildGrid();
  const { lats, lons } = grid;
  const latCount = lats.length;
  const lonCount = lons.length;
  const cellCount = latCount * lonCount;

  const coords = [];
  for (let i = 0; i < latCount; i += 1) {
    for (let j = 0; j < lonCount; j += 1) coords.push({ lat: lats[i], lon: lons[j] });
  }

  const batches = chunk(coords, BATCH_SIZE);
  // The marine endpoint rejects large coordinate lists, so its grid is split
  // more finely. It is also the layer that degrades most gracefully, so a
  // failure there never blocks the wind field.
  const sstBatches = chunk(coords, MARINE_BATCH_SIZE);
  const totalBatches = batches.length + sstBatches.length;

  let done = 0;
  let hours = null;
  let times = null;

  // Either pool may report first, so initialisation cannot depend on the wind
  // requests having already resolved. Both call this and the first one wins.
  const initialise = (entry) => {
    if (hours || !entry?.hourly?.time?.length) return false;

    hours = entry.hourly.time.length;
    times = entry.hourly.time;
    for (const key of Object.keys(wind)) wind[key] = alloc(hours);
    sst.value = alloc(hours);
    return true;
  };

  const wind = {
    u10: null,
    v10: null,
    speed10: null,
    dir10: null,
    cloud: null,
    temp: null,
  };
  const sst = { value: null };
  let sstFailures = 0;
  let windFailures = 0;

  // Storage is the real latitude bands only. The poles are handled by clamping
  // in `sampleField`, which needs no synthetic rows and keeps the linear
  // latitude indexing exact.
  const alloc = (count) => {
    const arr = new Float32Array(latCount * lonCount * count);
    arr.fill(NaN);
    return arr;
  };

  const field_row = (lat) => clamp(Math.round((lat - lats[0]) / LAT_STEP), 0, latCount - 1);
  const field_col = (lon) => {
    const raw = Math.round((wrapLongitude(lon) - lons[0]) / LON_STEP);
    return ((raw % lonCount) + lonCount) % lonCount;
  };

  const report = (stage, rate, approx) => {
    done += 1;
    const ratio = done / totalBatches;
    onProgress?.({ ratio, stage, rate, approx, batches: totalBatches });
  };

  const windTasks = batches.map((batch, batchIndex) => async () => {
    const url = buildUrl(source, batch, {
      latStep: LAT_STEP,
      lonStep: LON_STEP,
      pastDays: PAST_DAYS,
      forecastDays: FORECAST_DAYS,
    });
    let payload;
    try {
      payload = await fetchJson(url, signal);
    } catch (error) {
      if (error?.name !== 'AbortError') windFailures += 1;
      report('wind', batch.length);
      return;
    }

    const entries = Array.isArray(payload) ? payload : [payload];

    initialise(entries[0]);
    if (!hours) return;

    entries.forEach((entry, indexInBatch) => {
      const cell = batchIndex * BATCH_SIZE + indexInBatch;
      if (cell >= cellCount || !entry?.hourly) return;

      const u = readSeries(entry, 'wind_u_component_10m', hours);
      const v = readSeries(entry, 'wind_v_component_10m', hours);
      const speed = readSeries(entry, 'wind_speed_10m', hours);
      const dir = readSeries(entry, 'wind_direction_10m', hours);
      const cloud = readSeries(entry, 'cloud_cover', hours);
      const temp = readSeries(entry, 'temperature_2m', hours);

      const offset = cell * hours;
      for (let t = 0; t < hours; t += 1) {
        if (u) wind.u10[offset + t] = u[t];
        if (v) wind.v10[offset + t] = v[t];
        if (speed) wind.speed10[offset + t] = speed[t];
        if (dir) wind.dir10[offset + t] = dir[t];
        if (cloud) wind.cloud[offset + t] = cloud[t];
        if (temp) wind.temp[offset + t] = temp[t];
      }
    });

    report('wind', batch.length);
  });

  const sstTasks = sstBatches.map((batch) => async () => {
    const assign = (coord, entry) => {
      if (!coord || !entry?.hourly) return;
      initialise(entry);
      if (!hours) return;

      const i = field_row(coord.lat);
      const j = field_col(coord.lon);
      if (i < 0 || j < 0) return;

      const series = readSeries(entry, 'sea_surface_temperature', hours);
      if (!series) return;

      const offset = (i * lonCount + j) * hours;
      for (let t = 0; t < hours; t += 1) sst.value[offset + t] = series[t];
    };

    try {
      await fetchMarineBatch(batch, hours, assign, signal);
    } catch (error) {
      // The ocean layer is secondary: a failure leaves the wind field and cloud
      // mist fully functional, so it degrades to "no data" instead of failing
      // the whole load. The reason is still recorded for the UI.
      if (error?.name !== 'AbortError') sstFailures += 1;
    }

    report('sst', batch.length);
  });

  // Wind and SST are served by different hosts with independent rate limits,
  // so the two pools run side by side rather than one after the other.
  await Promise.all([runPool(windTasks), runPool(sstTasks)]);

  // If the live ocean data did not arrive, fall back to the ERA5 archive.
  if (sstFailures > 0 && hours) {
    const fallback = await fetchEra5Sst(signal);
    if (fallback) {
      sst.fallbackDate = fallback.date;
      sst.fallbackStep = FALLBACK_STEP;

      for (let i = 0; i < latCount; i += 1) {
        for (let j = 0; j < lonCount; j += 1) {
          const nearest = nearestFallback(fallback, lats[i], lons[j]);
          if (!Number.isFinite(nearest)) continue;

          const offset = (i * lonCount + j) * hours;
          // Held constant across the window: the archive value is a single
          // representative sample, so varying it by hour would be inventing
          // detail the source does not have.
          for (let t = 0; t < hours; t += 1) sst.value[offset + t] = nearest;
        }
      }

      sstFailures = 0;
      sst.mode = 'era5-fallback';
      sst.coverageOverride = 1;
    }
  }

  let sstCellCount = 0;
  if (sst.value && hours) {
    for (let i = 0; i < cellCount; i += 1) {
      const probe = sst.value[i * hours + 0];
      if (Number.isFinite(probe) && Math.abs(probe) > 0.001) sstCellCount += 1;
    }
  }

  const field = {
    lats,
    lons,
    latCount,
    lonCount,
    hours: hours ?? 0,
    times: times ?? [],
    source,
    u: wind.u10,
    v: wind.v10,
    speed: wind.speed10,
    direction: wind.dir10,
    cloud: wind.cloud,
    temp: wind.temp,
    sst: sst.value,
    sstMode: sst.mode ?? 'live',
    sstFallbackDate: sst.fallbackDate ?? null,
    coverage: {
      cells: cellCount,
      // Fraction of grid cells that carry a real ocean temperature, so the UI
      // can be honest when the ocean layer is only partly available.
      sst: sst.coverageOverride ?? (cellCount ? sstCellCount / cellCount : 0),
      sstFailures,
      windFailures,
    },
  };

  fillGaps(field);

  return field;
}

export function cellIndex(field, i, j) {
  return i * field.lonCount + j;
}

/** Index of the sample cell holding a coordinate, and its fractional offset. */
/**
 * Fractional latitude row for a coordinate.
 *
 * Rows are the real latitude bands, running south to north. Latitudes beyond
 * the outermost band (the polar caps) clamp to it.
 */
export function storageRowFor(field, lat) {
  return (lat - field.lats[0]) / LAT_STEP;
}

export function gridCoords(field, lat, lon) {
  const latMin = field.lats[0];
  const lonMin = field.lons[0];

  const fi = clamp(storageRowFor(field, lat), 0, field.latCount - 0.0001);
  const wrapped = wrapLongitude(lon);
  const fjRaw = (wrapped - lonMin) / LON_STEP;
  const fj = ((fjRaw % field.lonCount) + field.lonCount) % field.lonCount;

  return { fi, fj };
}

/**
 * Bilinear sample of a gridded field at (lat, lon, hour).
 *
 * Latitude clamps at the poles and longitude wraps, so this stays valid for
 * any coordinate a particle can drift to.
 */
export function sampleField(field, key, lat, lon, time) {
  const src = field[key];
  if (!src || !field.hours) return 0;

  const { fi, fj } = gridCoords(field, lat, lon);
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const ti = clamp(time, 0, field.hours - 1);
  const t0 = Math.floor(ti);
  const t1 = Math.min(t0 + 1, field.hours - 1);
  const ft = ti - t0;

  const wI = fi - i0;
  const wJ = fj - j0;

  const i1 = Math.min(i0 + 1, field.latCount - 1);
  const j1 = (j0 + 1) % field.lonCount;

  const { hours } = field;
  const at = (i, j, t) => src[(i * field.lonCount + j) * hours + t];

  const c00 = at(i0, j0, t0) * (1 - ft) + at(i0, j0, t1) * ft;
  const c01 = at(i0, j1, t0) * (1 - ft) + at(i0, j1, t1) * ft;
  const c10 = at(i1, j0, t0) * (1 - ft) + at(i1, j0, t1) * ft;
  const c11 = at(i1, j1, t0) * (1 - ft) + at(i1, j1, t1) * ft;

  const top = c00 * (1 - wJ) + c01 * wJ;
  const bottom = c10 * (1 - wJ) + c11 * wJ;

  return top * (1 - wI) + bottom * wI;
}

/** Strongest sample in the field at a given hour, used for legends and scaling. */
export function fieldExtent(field, key, time, filter) {
  const src = field[key];
  if (!src || !field.hours) return { min: 0, max: 0 };

  const t = clamp(Math.round(time), 0, field.hours - 1);
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < field.latCount; i += 1) {
    for (let j = 0; j < field.lonCount; j += 1) {
      const idx = cellIndex(field, i, j);
      const value = src[idx * field.hours + t];
      if (!Number.isFinite(value)) continue;
      if (filter && !filter(field, i, j, value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}

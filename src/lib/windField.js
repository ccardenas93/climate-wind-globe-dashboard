import * as THREE from 'three';
import { DEG, SURFACE_RADIUS, wrapLongitude, clamp } from './geo.js';
import { sampleField, storageRowFor, LAT_STEP, LON_STEP } from './fields.js';

const EARTH_RADIUS_M = 6371000;
const KMH_TO_MPS = 1 / 3.6;

/**
 * Latitude-scaled advection of a particle by the sampled wind.
 *
 * The API hands back u (eastward) and v (northward) in km/h. Converting to
 * degrees per second needs the physical distance a degree spans, which shrinks
 * with the cosine of latitude for longitude. Without that cos(lat) factor the
 * flow would smear across the map away from the equator.
 */
export function advect(lat, lon, uKmh, vKmh, dtSeconds) {
  const u = uKmh * KMH_TO_MPS;
  const v = vKmh * KMH_TO_MPS;

  const dLat = (v / EARTH_RADIUS_M) / DEG * dtSeconds;

  // Clamped rather than infinite so particles near the poles keep a sane speed
  // instead of accelerating as the meridians converge.
  const cosLat = Math.max(Math.cos(lat * DEG), 0.05);
  const dLon = (u / (EARTH_RADIUS_M * cosLat)) / DEG * dtSeconds;

  return {
    lat: clamp(lat + dLat, -89.5, 89.5),
    lon: wrapLongitude(lon + dLon),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polarWeight(lat) {
  const a = Math.abs(lat);
  if (a <= 62) return 1;
  if (a >= 82) return 0;
  return (82 - a) / 20;
}

/**
 * A swarm of tracer particles drifting with the real wind field.
 *
 * Positions are kept as lat/lon and written to a Float32Array each step; on
 * update only the changed range is uploaded to the GPU.
 */
export class WindParticleSim {
  constructor(count = 9000, seed = 20260917) {
    this.count = count;
    this.random = mulberry32(seed);

    this.positions = new Float32Array(count * 3);
    this.lat = new Float32Array(count);
    this.lon = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.speedKmh = new Float32Array(count);
    this.windDir = new Float32Array(count);
    this.motion = new Float32Array(count);

    for (let i = 0; i < count; i += 1) this.spawn(i);
  }

  spawn(index) {
    const rand = this.random;

    // sqrt sampling keeps the density even over the sphere instead of piling
    // particles up around the equator.
    const lat = (Math.asin(rand() * 2 - 1) * 180) / Math.PI;
    this.lat[index] = lat;
    this.lon[index] = rand() * 360 - 180;

    // Randomised life means the swarm continually refreshes instead of every
    // particle vanishing at the same moment.
    this.age[index] = rand() * 220;
    this.life[index] = 150 + rand() * 260;

    this.writePosition(index);
  }

  writePosition(index) {
    const lat = this.lat[index];
    const lon = this.lon[index];
    const phi = (90 - lat) * DEG;
    const theta = (lon + 180) * DEG;

    this.positions[index * 3] = -SURFACE_RADIUS * Math.sin(phi) * Math.cos(theta);
    this.positions[index * 3 + 1] = SURFACE_RADIUS * Math.cos(phi);
    this.positions[index * 3 + 2] = SURFACE_RADIUS * Math.sin(phi) * Math.sin(theta);
  }

  step(field, time, dtSeconds, rateScale = 1) {
    if (!field) return;

    // Capped so a long frame gap (tab switch) cannot teleport particles.
    const dt = clamp(dtSeconds * rateScale, 0, 0.25);

    for (let i = 0; i < this.count; i += 1) {
      const lat = this.lat[i];
      const lon = this.lon[i];

      const u = sampleField(field, 'u', lat, lon, time);
      const v = sampleField(field, 'v', lat, lon, time);

      const next = advect(lat, lon, u, v, dt);
      this.lat[i] = next.lat;
      this.lon[i] = next.lon;

      const speed = Math.hypot(u, v);
      this.speedKmh[i] = speed;
      this.windDir[i] = (Math.atan2(-u, -v) * 180) / Math.PI + 180;

      // Trail intensity follows the local wind speed.
      const target = clamp(speed / 70, 0, 1);
      this.motion[i] += (target - this.motion[i]) * 0.08;

      this.age[i] += dt * 60;
      if (this.age[i] > this.life[i]) {
        this.age[i] = 0;
        this.life[i] = 150 + this.random() * 260;
        this.spawn(i);
        continue;
      }

      this.writePosition(i);
    }
  }

  fillPointAttributes(alpha, size, motionOut) {
    for (let i = 0; i < this.count; i += 1) {
      const t = this.age[i] / this.life[i];

      // Fade in, hold, fade out. Clamped because a step can carry t past 1
      // before the particle is recycled, which would otherwise drive the
      // alpha negative and make the fragment shader darken instead.
      const fade = clamp(t < 0.15 ? t / 0.15 : t > 0.75 ? (1 - t) / 0.25 : 1, 0, 1);
      const speed = this.speedKmh[i];

      alpha[i] = clamp(fade * polarWeight(this.lat[i]), 0, 1);
      size[i] = (1.1 + (speed / 90) * 2.6) * (0.7 + fade * 0.6);
      motionOut[i] = this.motion[i];
    }
  }
}

/** Colour ramp for ocean temperature, cool blue through to deep red. */
const SEA_STOPS = [
  [-2, [0.09, 0.16, 0.45]],
  [0, [0.13, 0.32, 0.65]],
  [4, [0.15, 0.53, 0.78]],
  [9, [0.22, 0.73, 0.72]],
  [14, [0.42, 0.83, 0.5]],
  [19, [0.86, 0.87, 0.42]],
  [24, [0.94, 0.62, 0.32]],
  [28, [0.88, 0.32, 0.35]],
  [32, [0.61, 0.13, 0.32]],
];

export function seaColour(value) {
  if (!Number.isFinite(value)) return [0.05, 0.08, 0.16];
  if (value <= SEA_STOPS[0][0]) return SEA_STOPS[0][1];

  for (let i = 1; i < SEA_STOPS.length; i += 1) {
    const [v1, c1] = SEA_STOPS[i];
    if (value <= v1) {
      const [v0, c0] = SEA_STOPS[i - 1];
      const t = (value - v0) / (v1 - v0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }

  return SEA_STOPS[SEA_STOPS.length - 1][1];
}

/** Colour ramp for temperature anomaly against the ERA5 baseline. */
const ANOMALY_STOPS = [
  [-4, [0.16, 0.29, 0.72]],
  [-2, [0.28, 0.53, 0.85]],
  [-1, [0.52, 0.74, 0.9]],
  [0, [0.9, 0.9, 0.9]],
  [1, [0.94, 0.79, 0.5]],
  [2, [0.9, 0.53, 0.26]],
  [4, [0.72, 0.16, 0.2]],
];

export function anomalyColour(value) {
  if (!Number.isFinite(value)) return [0.05, 0.08, 0.16];
  if (value <= ANOMALY_STOPS[0][0]) return ANOMALY_STOPS[0][1];

  for (let i = 1; i < ANOMALY_STOPS.length; i += 1) {
    const [v1, c1] = ANOMALY_STOPS[i];
    if (value <= v1) {
      const [v0, c0] = ANOMALY_STOPS[i - 1];
      const t = (value - v0) / (v1 - v0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }

  return ANOMALY_STOPS[ANOMALY_STOPS.length - 1][1];
}

/**
 * Paints the ocean-temperature layer as an equirectangular texture.
 *
 * The texture grid lines up with `latLonToVector3`, so coastlines land in the
 * right place. Cells without an SST sample (land, and the first pass over
 * coastal cells) are filled from neighbouring ocean cells instead of being
 * left as holes.
 *
 * One texel per field cell is deliberate: the GPU's linear filtering does the
 * interpolation, which keeps a rebuild cheap enough to run while the time
 * slider is being dragged.
 */
export function buildSeaTexture(field, time, { mode = 'absolute', climatology = null } = {}) {
  const { latCount, lonCount } = field;

  // Three texels per field cell: enough for smooth gradients and a coastline
  // that does not look blocky, while staying cheap enough (a few thousand
  // texels, well under a millisecond) to rebuild on every time step.
  const SCALE = 3;
  const width = lonCount * SCALE;
  const height = latCount * SCALE;

  const month = new Date().getUTCMonth();

  // Latitude of each texture row. Rows run north to south to match texture v.
  const rowLat = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    rowLat[y] = 90 - ((y + 0.5) / height) * 180;
  }

  // Coarse ocean mask and values, one entry per field cell.
  const coarseValue = new Float32Array(latCount * lonCount);
  const coarseOcean = new Uint8Array(latCount * lonCount);

  for (let i = 0; i < latCount; i += 1) {
    for (let j = 0; j < lonCount; j += 1) {
      const idx = i * lonCount + j;
      const sample = sampleField(field, 'sst', field.lats[i], field.lons[j], time);

      // The marine API returns null over land, and zero is not a physically
      // reachable sea surface temperature, so both mean "no ocean here".
      if (Number.isFinite(sample) && Math.abs(sample) > 0.001) {
        coarseValue[idx] = sample;
        coarseOcean[idx] = 1;
      }
    }
  }

  // One wrap-around nearest-neighbour pass closes coastal gaps so islands and
  // shorelines do not punch holes in the layer.
  const filledValue = Float32Array.from(coarseValue);
  for (let i = 0; i < latCount; i += 1) {
    for (let j = 0; j < lonCount; j += 1) {
      const idx = i * lonCount + j;
      if (coarseOcean[idx]) continue;

      for (const n of [
        i * lonCount + ((j + 1) % lonCount),
        i * lonCount + ((j - 1 + lonCount) % lonCount),
        Math.min(i + 1, latCount - 1) * lonCount + j,
        Math.max(i - 1, 0) * lonCount + j,
      ]) {
        if (coarseOcean[n]) {
          filledValue[idx] = coarseValue[n];
          break;
        }
      }
    }
  }

  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const lat = rowLat[y];

    // Bilinear position in field-cell space, used to interpolate the ocean mask
    // so the coastline gets a soft edge instead of a staircase. Uses the same
    // row formula as the sampler, so the two cannot drift apart.
    const fi = clamp(storageRowFor(field, lat), 0, latCount - 1 - 0.0001);
    const i0 = Math.floor(fi);
    const i1 = Math.min(i0 + 1, latCount - 1);
    const wI = fi - i0;

    for (let x = 0; x < width; x += 1) {
      const lon = ((x + 0.5) / width) * 360 - 180;

      const fjRaw = (lon - field.lons[0]) / LON_STEP;
      const fj = ((fjRaw % lonCount) + lonCount) % lonCount;
      const j0 = Math.floor(fj) % lonCount;
      const j1 = (j0 + 1) % lonCount;
      const wJ = fj - Math.floor(fj);

      const t00 = i0 * lonCount + j0;
      const t01 = i0 * lonCount + j1;
      const t10 = i1 * lonCount + j0;
      const t11 = i1 * lonCount + j1;

      const seaWeight = clamp(
        (coarseOcean[t00] * (1 - wJ) + coarseOcean[t01] * wJ) * (1 - wI) +
          (coarseOcean[t10] * (1 - wJ) + coarseOcean[t11] * wJ) * wI,
        0,
        1
      );

      let value =
        (filledValue[t00] * (1 - wJ) + filledValue[t01] * wJ) * (1 - wI) +
        (filledValue[t10] * (1 - wJ) + filledValue[t11] * wJ) * wI;

      if (mode === 'anomaly') {
        const baseline = sampleClimatology(climatology, lat, lon, month);
        value = Number.isFinite(baseline) ? value - baseline : NaN;
      }

      const land = [0.055, 0.075, 0.11];
      const rgb = seaWeight > 0 ? (mode === 'anomaly' ? anomalyColour(value) : seaColour(value)) : land;

      const o = (y * width + x) * 4;
      data[o] = Math.round(rgb[0] * 255);
      data[o + 1] = Math.round(rgb[1] * 255);
      data[o + 2] = Math.round(rgb[2] * 255);
      data[o + 3] = Math.round(seaWeight * 255);
    }
  }

  // A canvas texture is used so the browser handles the sRGB conversion and the
  // GPU upload in one step.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  image.data.set(data);
  context.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;

  return texture;
}


function sampleClimatology(climatology, lat, lon, month) {
  if (!climatology) return NaN;

  const { lats, lons, monthly } = climatology;
  if (!monthly || !monthly.length) return NaN;

  const latIdx = nearestIndex(lats, lat);
  const lonIdx = nearestIndex(lons, wrapLongitude(lon));
  const monthIdx = clamp(month, 0, monthly[0].length - 1);

  const row = monthly[latIdx];
  if (!row) return NaN;

  return row[monthIdx]?.[lonIdx] ?? NaN;
}

function nearestIndex(values, target) {
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const delta = Math.abs(values[i] - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

/**
 * Cloud-cover and wind texture sampled by the mist and particle shaders.
 *
 * Stored as raw values rather than colours so the shaders can interpolate and
 * colour on the GPU, with longitude wrapping built into the sampling.
 */
export function buildCloudTexture(field) {
  const { latCount, lonCount } = field;
  const data = new Float32Array(latCount * lonCount * 4);

  const centroid = Math.max(1, Math.round(field.hours / 2));

  for (let i = 0; i < latCount; i += 1) {
    for (let j = 0; j < lonCount; j += 1) {
      const o = (i * lonCount + j) * 4;
      const cloud = sampleField(field, 'cloud', field.lats[i], field.lons[j], centroid) / 100;
      const speed = sampleField(field, 'speed', field.lats[i], field.lons[j], centroid) / 70;
      const u = sampleField(field, 'u', field.lats[i], field.lons[j], centroid) / 70;
      const v = sampleField(field, 'v', field.lats[i], field.lons[j], centroid) / 70;

      data[o] = clamp(cloud, 0, 1);
      data[o + 1] = clamp(speed, 0, 1);
      data[o + 2] = (u + 1) / 2;
      data[o + 3] = (v + 1) / 2;
    }
  }

  const texture = new THREE.DataTexture(data, lonCount, latCount, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;

  return texture;
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { motion } from 'framer-motion';

import GlobeScene from './components/GlobeScene.jsx';
import {
  fetchGlobalFields,
  sampleField,
  fieldExtent,
  LAT_STEP,
  LON_STEP,
  PAST_DAYS,
  FORECAST_DAYS,
  FIELD_SOURCES,
} from './lib/fields.js';
import { buildSeaTexture, buildCloudTexture } from './lib/windField.js';
import { readFieldCache, writeFieldCache } from './lib/fieldCache.js';

const defaultLocation = {
  name: 'London',
  latitude: 51.5072,
  longitude: -0.1276,
  country: 'United Kingdom',
};

const weatherCodes = {
  0: { label: 'Clear', icon: '☀️' },
  1: { label: 'Mostly clear', icon: '🌤️' },
  2: { label: 'Partly cloudy', icon: '⛅' },
  3: { label: 'Cloudy', icon: '☁️' },
  45: { label: 'Fog', icon: '🌫️' },
  48: { label: 'Depositing rime fog', icon: '🌫️' },
  51: { label: 'Light drizzle', icon: '🌦️' },
  53: { label: 'Drizzle', icon: '🌦️' },
  55: { label: 'Heavy drizzle', icon: '🌧️' },
  56: { label: 'Freezing drizzle', icon: '🌧️' },
  57: { label: 'Heavy freezing drizzle', icon: '🌧️' },
  61: { label: 'Light rain', icon: '🌦️' },
  63: { label: 'Rain', icon: '🌧️' },
  65: { label: 'Heavy rain', icon: '🌧️' },
  66: { label: 'Freezing rain', icon: '🌧️' },
  67: { label: 'Heavy freezing rain', icon: '🌧️' },
  71: { label: 'Light snow', icon: '🌨️' },
  73: { label: 'Snow', icon: '❄️' },
  75: { label: 'Heavy snow', icon: '❄️' },
  77: { label: 'Snow grains', icon: '❄️' },
  80: { label: 'Rain showers', icon: '🌦️' },
  81: { label: 'Heavy showers', icon: '🌧️' },
  82: { label: 'Violent showers', icon: '⛈️' },
  85: { label: 'Snow showers', icon: '🌨️' },
  86: { label: 'Heavy snow showers', icon: '🌨️' },
  95: { label: 'Thunderstorm', icon: '⛈️' },
  96: { label: 'Thunderstorm with hail', icon: '⛈️' },
  99: { label: 'Severe thunderstorm', icon: '⛈️' },
};

const cityPresets = [
  { name: 'London', latitude: 51.5072, longitude: -0.1276, country: 'United Kingdom' },
  { name: 'New York', latitude: 40.7128, longitude: -74.006, country: 'United States' },
  { name: 'Tokyo', latitude: 35.6762, longitude: 139.6503, country: 'Japan' },
  { name: 'Cairo', latitude: 30.0444, longitude: 31.2357, country: 'Egypt' },
  { name: 'Sydney', latitude: -33.8688, longitude: 151.2093, country: 'Australia' },
  { name: 'Rio de Janeiro', latitude: -22.9068, longitude: -43.1729, country: 'Brazil' },
  { name: 'Cape Town', latitude: -33.9249, longitude: 18.4241, country: 'South Africa' },
  { name: 'Reykjavik', latitude: 64.1466, longitude: -21.9426, country: 'Iceland' },
];

function getWeatherLabel(code) {
  return weatherCodes[code] || { label: 'Weather', icon: '🌍' };
}

async function fetchSearchSuggestions(query) {
  if (!query.trim()) return [];

  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`
  );

  if (!response.ok) throw new Error('Unable to fetch search results');

  const data = await response.json();
  return data.results || [];
}

async function fetchWeatherData(location, signal) {
  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,weather_code,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7`,
    { signal }
  );

  if (!response.ok) throw new Error('Weather service unavailable');

  return response.json();
}

/** Index of the hour closest to now, so the globe opens on "live". */
function nearestHour(field) {
  const now = Date.now();
  let best = 0;
  let bestDelta = Infinity;

  field.times.forEach((iso, index) => {
    const delta = Math.abs(new Date(`${iso}Z`).getTime() - now);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = index;
    }
  });

  return best;
}

function formatHour(iso) {
  if (!iso) return '—';
  const date = new Date(`${iso}Z`);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function relativeLabel(iso) {
  if (!iso) return '';
  const target = new Date(`${iso}Z`).getTime();
  const diffHours = Math.round((target - Date.now()) / 3600000);

  if (Math.abs(diffHours) < 1) return 'current hour';
  if (diffHours > 0) return `+${diffHours} h ahead`;
  return `${Math.abs(diffHours)} h earlier`;
}

/** Layers the user can toggle. */
const LAYER_DEFS = [
  { id: 'wind', label: 'Wind tracers', hint: 'Particles advected by 10 m u/v wind' },
  { id: 'mist', label: 'Cloud mist', hint: 'Cloud-cover shells drifting with the flow' },
  { id: 'sea', label: 'Sea temperature', hint: 'Sea surface temperature' },
  { id: 'marker', label: 'City marker', hint: 'Selected location readout' },
];

export default function App() {
  const [query, setQuery] = useState('');
  const [selectedLocation, setSelectedLocation] = useState(defaultLocation);
  const [suggestions, setSuggestions] = useState([]);
  const [weather, setWeather] = useState(null);
  const [weatherError, setWeatherError] = useState('');
  const [weatherLoading, setWeatherLoading] = useState(false);

  const [field, setField] = useState(null);
  const [fieldStatus, setFieldStatus] = useState({ state: 'idle', ratio: 0, error: null });
  const [source, setSource] = useState('forecast');
  const [hourIndex, setHourIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [autoRotate, setAutoRotate] = useState(true);
  const [layers, setLayers] = useState({ wind: true, mist: true, sea: true, marker: true });
  const [seaTexture, setSeaTexture] = useState(null);
  const [cloudTexture, setCloudTexture] = useState(null);

  const loadField = useCallback(
    async (nextSource, signal) => {
      setFieldStatus({ state: 'loading', ratio: 0, error: null });
      try {
        // A cached field makes a reload instant and avoids spending rate-limit
        // budget on data that is only a few minutes old.
        const cached = readFieldCache(nextSource);
        if (cached) {
          setCloudTexture(buildCloudTexture(cached));
          setField(cached);
          setHourIndex(nearestHour(cached));
          setFieldStatus({ state: 'ready', ratio: 1, error: null, cached: true });
          return;
        }

        const loaded = await fetchGlobalFields({
          source: nextSource,
          signal,
          onProgress: ({ ratio }) => setFieldStatus({ state: 'loading', ratio, error: null }),
        });

        if (signal?.aborted) return;

        const best = nearestHour(loaded);

        setField(loaded);
        setHourIndex(best);
        setCloudTexture(buildCloudTexture(loaded));
        setFieldStatus({ state: 'ready', ratio: 1, error: null });
        writeFieldCache(nextSource, loaded);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        setFieldStatus({ state: 'error', ratio: 0, error: error.message || 'Wind field unavailable' });
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    loadField(source, controller.signal);
    return () => controller.abort();
  }, [source, loadField]);

  useEffect(() => {
    const controller = new AbortController();

    const run = async () => {
      setWeatherLoading(true);
      setWeatherError('');
      try {
        const data = await fetchWeatherData(selectedLocation, controller.signal);
        setWeather(data);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        setWeatherError(error.message || 'Unable to load weather data.');
      } finally {
        if (!controller.signal.aborted) setWeatherLoading(false);
      }
    };

    run();
    return () => controller.abort();
  }, [selectedLocation]);

  // Rebuild the ocean texture when the hour changes. Building at the field's
  // own resolution is fast enough to feel immediate while dragging.
  useEffect(() => {
    if (!field || !layers.sea) return;
    const texture = buildSeaTexture(field, hourIndex);
    setSeaTexture(texture);
    return () => {
      // Canvas textures hold a canvas element as well as GPU memory.
      if (texture.image) {
        texture.image.width = 0;
        texture.image.height = 0;
      }
      texture.dispose();
    };
  }, [field, hourIndex, layers.sea]);

  // Scrub the field's time axis while the tracers keep drifting.
  useEffect(() => {
    if (!playing || !field) return undefined;

    const id = setInterval(() => {
      setHourIndex((current) => {
        const next = current + 1;
        return next >= field.hours ? 0 : next;
      });
    }, Math.max(160, 900 / rate));

    return () => clearInterval(id);
  }, [playing, field, rate]);

  const handleSearch = async () => {
    if (!query.trim()) {
      setSuggestions(cityPresets);
      return;
    }

    try {
      const results = await fetchSearchSuggestions(query);
      setSuggestions(results.length ? results : cityPresets);
    } catch {
      setSuggestions(cityPresets);
    }
  };

  const handleSelect = (location) => {
    setSelectedLocation({
      name: location.name,
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      country: location.country || location.admin1 || 'N/A',
    });
    setQuery(location.name);
    setSuggestions([]);
  };

  const toggleLayer = (id) => setLayers((current) => ({ ...current, [id]: !current[id] }));

  const current = weather?.current;
  const daily = weather?.daily;
  const currentWeatherLabel = getWeatherLabel(current?.weather_code);

  // Conditions sampled straight out of the gridded field, so the sidebar and
  // the globe are reading the same numbers.
  const sampled = useMemo(() => {
    if (!field) return null;

    const { latitude, longitude } = selectedLocation;
    const windSpeed = sampleField(field, 'speed', latitude, longitude, hourIndex);
    const windDir = sampleField(field, 'direction', latitude, longitude, hourIndex);
    const cloud = sampleField(field, 'cloud', latitude, longitude, hourIndex);
    const temp = sampleField(field, 'temp', latitude, longitude, hourIndex);
    const sst = sampleField(field, 'sst', latitude, longitude, hourIndex);

    return { windSpeed, windDir, cloud, temp, sst };
  }, [field, selectedLocation, hourIndex]);

  const windExtent = useMemo(
    () => (field ? fieldExtent(field, 'speed', hourIndex) : { min: 0, max: 0 }),
    [field, hourIndex]
  );

  const seaExtent = useMemo(() => {
    if (!field) return { min: 0, max: 0 };
    return fieldExtent(field, 'sst', hourIndex, (f, i, j, value) => Number.isFinite(value) && value !== 0);
  }, [field, hourIndex]);

  const activeSource = FIELD_SOURCES[source];
  const busy = fieldStatus.state === 'loading';

  // The field records how much of each layer actually arrived, so a rate-limited
  // load is reported rather than quietly drawn as if it were complete.
  const partial = Boolean(
    field &&
      (field.sstMode === 'era5-fallback' ||
        field.coverage?.windFailures > 0 ||
        (field.coverage?.sst ?? 1) < 0.5)
  );

  return (
    <div className="app-shell">
      <aside className="panel left-panel">
        <div className="brand-block">
          <div className="brand-mark">✦</div>
          <div>
            <p className="eyebrow">Climate intelligence</p>
            <h1>Atmosphere Watch</h1>
          </div>
        </div>

        <div className="search-box">
          <label htmlFor="location-search">Search location</label>
          <div className="search-row">
            <input
              id="location-search"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSearch();
              }}
              placeholder="Search a city..."
              aria-label="Search city"
            />
            <button type="button" onClick={handleSearch}>
              Locate
            </button>
          </div>

          {suggestions.length > 0 && (
            <div className="suggestions">
              {suggestions.map((item) => (
                <button
                  key={`${item.name}-${item.latitude}-${item.longitude}`}
                  type="button"
                  onClick={() => handleSelect(item)}
                >
                  {item.name} · {item.country || item.admin1 || 'Worldwide'}
                </button>
              ))}
            </div>
          )}
        </div>

        <motion.div
          className="status-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          {weatherLoading ? (
            <div className="loading-message">Loading atmospheric data...</div>
          ) : weatherError ? (
            <div className="error-message">{weatherError}</div>
          ) : (
            <>
              <div className="status-header">
                <div>
                  <p className="eyebrow">Now</p>
                  <h2>{selectedLocation.name}</h2>
                </div>
                <span className="weather-badge">
                  {currentWeatherLabel.icon} {currentWeatherLabel.label}
                </span>
              </div>

              <div className="temperature-row">
                <span className="temperature">{Math.round(current?.temperature_2m ?? 0)}°</span>
                <span className="temperature-meta">
                  Feels like {Math.round(current?.apparent_temperature ?? 0)}°
                </span>
              </div>

              <div className="stat-grid">
                <div>
                  <span>Wind</span>
                  <strong>{Math.round(current?.wind_speed_10m ?? 0)} km/h</strong>
                </div>
                <div>
                  <span>Humidity</span>
                  <strong>{Math.round(current?.relative_humidity_2m ?? 0)}%</strong>
                </div>
                <div>
                  <span>Pressure</span>
                  <strong>{Math.round(current?.pressure_msl ?? 0)} hPa</strong>
                </div>
                <div>
                  <span>Direction</span>
                  <strong>{Math.round(current?.wind_direction_10m ?? 0)}°</strong>
                </div>
              </div>
            </>
          )}
        </motion.div>

        <div className="forecast-card">
          <div className="section-title-row">
            <h3>7-day outlook</h3>
            <span>{selectedLocation.country}</span>
          </div>

          <div className="forecast-list">
            {daily?.time?.map((day, index) => {
              const label = getWeatherLabel(daily.weather_code[index]);
              return (
                <div key={day} className="forecast-item">
                  <span>{new Date(day).toLocaleDateString('en-US', { weekday: 'short' })}</span>
                  <strong>{label.icon}</strong>
                  <span>
                    {Math.round(daily.temperature_2m_max[index])}° / {Math.round(daily.temperature_2m_min[index])}°
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </aside>

      <main className="globe-panel">
        <div className="map-header">
          <div>
            <p className="eyebrow">Wind field physics</p>
            <h2>Global circulation</h2>
          </div>
          <div className="header-badges">
            <span>{activeSource.label}</span>
            <span>{FIELD_SOURCES.forecast.detail}</span>
          </div>
        </div>

        <div className="globe-shell">
          <Canvas
            camera={{ position: [0, 0, 5], fov: 45 }}
            dpr={[1, 2]}
            gl={{ antialias: true, powerPreference: 'high-performance' }}
          >
            <GlobeScene
              field={field}
              time={hourIndex}
              layers={layers}
              rate={rate}
              density={layers.mist ? 1 : 0}
              seaTexture={seaTexture}
              cloudTexture={cloudTexture}
              autoRotate={autoRotate}
              location={selectedLocation}
              weather={weather}
            />
          </Canvas>

          {busy && (
            <div className="globe-overlay">
              <div className="loading-message">Sampling the global wind field…</div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(fieldStatus.ratio * 100)}%` }} />
              </div>
              <p className="overlay-note">
                {Math.round(fieldStatus.ratio * 100)}% · {LAT_STEP}° grid, {PAST_DAYS}d history +{' '}
                {FORECAST_DAYS}d forecast
              </p>
            </div>
          )}

          {fieldStatus.state === 'error' && (
            <div className="globe-overlay">
              <div className="error-message">{fieldStatus.error}</div>
              <button type="button" onClick={() => loadField(source, undefined)}>
                Retry
              </button>
            </div>
          )}
        </div>

        <div className="timeline-bar">
          <button type="button" className="play-button" onClick={() => setPlaying((p) => !p)} disabled={!field}>
            {playing ? '❚❚' : '▶'}
          </button>

          <div className="timeline-main">
            <input
              type="range"
              min={0}
              max={Math.max((field?.hours ?? 1) - 1, 0)}
              value={hourIndex}
              onChange={(event) => setHourIndex(Number(event.target.value))}
              disabled={!field}
              aria-label="Forecast hour"
            />
            <div className="timeline-meta">
              <strong>{formatHour(field?.times?.[hourIndex])}</strong>
              <span>{relativeLabel(field?.times?.[hourIndex])}</span>
            </div>
          </div>

          <label className="rate-control">
            <span>Speed</span>
            <input
              type="range"
              min={0.25}
              max={3}
              step={0.25}
              value={rate}
              onChange={(event) => setRate(Number(event.target.value))}
            />
            <strong>{rate}×</strong>
          </label>

          <button type="button" className="ghost-button" onClick={() => setAutoRotate((v) => !v)}>
            {autoRotate ? 'Pause spin' : 'Auto spin'}
          </button>
        </div>

        <div className="controls-row">
          <div className="layer-chips">
            {LAYER_DEFS.map((layer) => (
              <button
                key={layer.id}
                type="button"
                className={`chip ${layers[layer.id] ? 'chip-on' : ''}`}
                onClick={() => toggleLayer(layer.id)}
                title={layer.hint}
              >
                {layer.label}
              </button>
            ))}
          </div>

          <div className="source-picker">
            {Object.values(FIELD_SOURCES).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip ${source === item.id ? 'chip-on' : ''}`}
                onClick={() => setSource(item.id)}
                title={item.detail}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="metrics-bar">
          <div>
            <span>Field wind @ city</span>
            <strong>{Math.round(sampled?.windSpeed ?? 0)} km/h</strong>
          </div>
          <div>
            <span>Peak field wind</span>
            <strong>{Math.round(windExtent.max)} km/h</strong>
          </div>
          <div>
            <span>Cloud cover @ city</span>
            <strong>{Math.round(sampled?.cloud ?? 0)}%</strong>
          </div>
          <div>
            <span>Sea surface temp</span>
            <strong>
              {sampled?.sst ? `${sampled.sst.toFixed(1)} °C` : '—'}
            </strong>
          </div>
        </div>

        <div className="legend-bar">
          <div className="legend">
            <span className="legend-title">Sea temp</span>
            <div className="ramp ramp-sea" />
            <span className="legend-range">
              {seaExtent.min.toFixed(1)}° – {seaExtent.max.toFixed(1)}°C
            </span>
          </div>

          <div className="legend">
            <span className="legend-title">Wind</span>
            <div className="ramp ramp-wind" />
            <span className="legend-range">
              calm → {Math.round(windExtent.max)} km/h
            </span>
          </div>

          {partial && (
            <p className="coverage-note">
              {field.sstMode === 'era5-fallback'
                ? `Live ocean data was rate-limited, so sea temperature is showing the ERA5 reanalysis for ${field.sstFallbackDate}. `
                : field.coverage.sst < 0.5
                ? `Ocean layer is only ${Math.round(field.coverage.sst * 100)}% complete (${
                    field.coverage.sstFailures
                  } request${field.coverage.sstFailures === 1 ? '' : 's'} rate-limited). `
                : ''}
              {field.coverage.windFailures > 0
                ? `${field.coverage.windFailures} wind request${
                    field.coverage.windFailures === 1 ? '' : 's'
                  } were rate-limited, so gaps are filled from neighbouring cells. `
                : ''}
              Reload in a minute for full coverage.
            </p>
          )}

          <p className="attribution">
            {activeSource.attribution} · {LAT_STEP}° × {LON_STEP}° sampled grid · u/v advected at real
            wind speed
          </p>
        </div>
      </main>
    </div>
  );
}

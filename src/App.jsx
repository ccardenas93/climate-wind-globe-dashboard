import { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stars, Text, Html, Tube } from '@react-three/drei';
import * as THREE from 'three';
import { motion } from 'framer-motion';

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

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function latLonToVector3(lat, lon, radius = 1.55) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);

  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(phi) * Math.sin(theta);

  return new THREE.Vector3(x, y, z);
}

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

async function fetchWeatherData(location) {
  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,weather_code,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7`
  );

  if (!response.ok) throw new Error('Weather service unavailable');

  return response.json();
}

function App() {
  const [query, setQuery] = useState('');
  const [selectedLocation, setSelectedLocation] = useState(defaultLocation);
  const [suggestions, setSuggestions] = useState([]);
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadWeather = async () => {
      setLoading(true);
      setError('');

      try {
        const data = await fetchWeatherData(selectedLocation);
        setWeather(data);
      } catch (err) {
        setError(err.message || 'Unable to load weather data.');
      } finally {
        setLoading(false);
      }
    };

    loadWeather();
  }, [selectedLocation]);

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

  const current = weather?.current;
  const daily = weather?.daily;
  const hourly = weather?.hourly;

  const airFlowCurves = useMemo(() => {
    const points = [
      { lat: 12, lon: -15 },
      { lat: 32, lon: 10 },
      { lat: 45, lon: 40 },
      { lat: 10, lon: 80 },
      { lat: -20, lon: 120 },
      { lat: -40, lon: 160 },
      { lat: -15, lon: -120 },
      { lat: 25, lon: -90 },
    ];

    return points.map((point, index) => {
      const start = latLonToVector3(selectedLocation.latitude, selectedLocation.longitude, 1.55);
      const end = latLonToVector3(point.lat, point.lon, 1.55);
      const mid = start.clone().add(end).multiplyScalar(0.52);
      const offset = new THREE.Vector3(
        (index % 2 === 0 ? 1 : -1) * 0.7,
        (index % 3) * 0.25,
        (index % 2 === 0 ? -1 : 1) * 0.7
      );
      const curve = new THREE.CatmullRomCurve3([
        start,
        mid.clone().add(offset),
        end.clone().add(offset.clone().multiplyScalar(0.3)),
        end,
      ]);

      return {
        curve,
        color: index % 2 === 0 ? '#67e8f9' : '#c084fc',
      };
    });
  }, [selectedLocation]);

  const currentWeatherLabel = getWeatherLabel(current?.weather_code);

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
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a city..."
              aria-label="Search city"
            />
            <button type="button" onClick={handleSearch}>Locate</button>
          </div>

          {suggestions.length > 0 && (
            <div className="suggestions">
              {suggestions.map((item) => (
                <button key={`${item.name}-${item.latitude}-${item.longitude}`} type="button" onClick={() => handleSelect(item)}>
                  {item.name} · {item.country || item.admin1 || 'Worldwide'}
                </button>
              ))}
            </div>
          )}
        </div>

        <motion.div
          className="status-card"
          key={selectedLocation.name}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
        >
          {loading ? (
            <div className="loading-message">Loading atmospheric data...</div>
          ) : error ? (
            <div className="error-message">{error}</div>
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
                <span className="temperature-meta">Feels like {Math.round(current?.apparent_temperature ?? 0)}°</span>
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
              const code = daily.weather_code[index];
              const label = getWeatherLabel(code);
              const max = Math.round(daily.temperature_2m_max[index]);
              const min = Math.round(daily.temperature_2m_min[index]);

              return (
                <div key={day} className="forecast-item">
                  <span>{new Date(day).toLocaleDateString('en-US', { weekday: 'short' })}</span>
                  <strong>{label.icon}</strong>
                  <span>{max}° / {min}°</span>
                </div>
              );
            })}
          </div>
        </div>
      </aside>

      <main className="globe-panel">
        <div className="map-header">
          <div>
            <p className="eyebrow">Air currents</p>
            <h2>Global flow model</h2>
          </div>
          <div className="header-badges">
            <span>Live</span>
            <span>Open-Meteo</span>
          </div>
        </div>

        <div className="globe-shell">
          <Canvas camera={{ position: [0, 0, 5], fov: 45 }}>
            <color attach="background" args={['#07111f']} />
            <fog attach="fog" args={['#07111f', 5, 12]} />
            <ambientLight intensity={0.8} />
            <directionalLight position={[5, 2, 5]} intensity={1.4} color="#dbeafe" />
            <Stars radius={60} depth={30} count={5000} factor={3} saturation={0} fade speed={0.8} />

            <GlobeComponent location={selectedLocation} weather={weather} airFlowCurves={airFlowCurves} />

            <OrbitControls enableZoom={false} enablePan={false} autoRotate autoRotateSpeed={0.6} />
          </Canvas>
        </div>

        <div className="metrics-bar">
          <div>
            <span>Cloud cover</span>
            <strong>{Math.min(100, Math.max(0, (hourly?.precipitation_probability?.[0] ?? 0) + 10))}%</strong>
          </div>
          <div>
            <span>Air mass</span>
            <strong>{Math.round(current?.wind_speed_10m ?? 0) > 25 ? 'Dynamic' : 'Stable'}</strong>
          </div>
          <div>
            <span>Trend</span>
            <strong>{Math.round(current?.temperature_2m ?? 0) > 20 ? 'Warm' : 'Cool'}</strong>
          </div>
        </div>
      </main>
    </div>
  );
}

function GlobeComponent({ location, weather, airFlowCurves }) {
  const selectedVec = useMemo(
    () => latLonToVector3(location.latitude, location.longitude, 1.82),
    [location]
  );

  const selectedWeather = weather?.current;
  const windSpeed = selectedWeather?.wind_speed_10m ?? 15;

  return (
    <group>
      <mesh>
        <sphereGeometry args={[1.5, 64, 64]} />
        <meshStandardMaterial
          color="#0f172a"
          emissive="#1e3a8a"
          emissiveIntensity={0.25}
          roughness={0.8}
          metalness={0.15}
        />
      </mesh>

      <mesh scale={1.08}>
        <sphereGeometry args={[1.5, 64, 64]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.14} />
      </mesh>

      {airFlowCurves.map((arc, index) => (
        <group key={index}>
          <Tube args={[arc.curve, 160, 0.008, 4, false]}>
            <meshStandardMaterial color={arc.color} emissive={arc.color} emissiveIntensity={0.8} />
          </Tube>
        </group>
      ))}

      {Array.from({ length: 32 }).map((_, index) => {
        const lat = (index * 17) % 180 - 90;
        const lon = (index * 29) % 360 - 180;
        const pos = latLonToVector3(lat, lon, 1.74);

        return (
          <mesh key={`${lat}-${lon}`} position={pos.toArray()}>
            <sphereGeometry args={[0.02, 10, 10]} />
            <meshBasicMaterial color={index % 2 === 0 ? '#7dd3fc' : '#c4b5fd'} />
          </mesh>
        );
      })}

      <mesh position={selectedVec.toArray()}>
        <sphereGeometry args={[0.09 + windSpeed / 100, 32, 32]} />
        <meshStandardMaterial color="#fbbf24" emissive="#f59e0b" emissiveIntensity={1.4} />
      </mesh>

      <Html position={selectedVec.toArray()} center distanceFactor={7} zIndexRange={[10, 0]}>
        <div className="marker-readout">
          <span className="marker-wind">{Math.round(windSpeed)} km/h</span>
          <span className="marker-temp">{Math.round(selectedWeather?.temperature_2m ?? 0)}°</span>
        </div>
      </Html>

      <Text
        position={[selectedVec.x * 0.9, selectedVec.y * 0.9, selectedVec.z * 0.9]}
        fontSize={0.12}
        color="#f8fafc"
        anchorX="center"
        anchorY="middle"
      >
        {location.name}
      </Text>
    </group>
  );
}

export default App;

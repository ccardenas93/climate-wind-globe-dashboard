/**
 * Local cache for the sampled global field.
 *
 * Downloading the field costs a few dozen rate-limited requests, and the data
 * only changes once an hour, so a reload should not pay for it again. Entries
 * are dropped when they are older than the freshness window so a stale field is
 * never mistaken for a live one.
 *
 * Typed arrays are stored as plain arrays because structured clone of a
 * Float32Array does not survive every browser's storage layer.
 */

const CACHE_PREFIX = 'cwgd:field:';
const CACHE_VERSION = 1;
const FRESH_MS = 30 * 60 * 1000;

const TYPED_KEYS = ['u', 'v', 'speed', 'direction', 'cloud', 'temp', 'sst'];

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Private-mode or blocked storage: caching is simply skipped.
    return null;
  }
}

export function readFieldCache(source) {
  const store = storage();
  if (!store) return null;

  try {
    const raw = store.getItem(CACHE_PREFIX + source);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (parsed?.version !== CACHE_VERSION) return null;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > FRESH_MS) {
      store.removeItem(CACHE_PREFIX + source);
      return null;
    }

    const field = { ...parsed.field };
    for (const key of TYPED_KEYS) {
      if (Array.isArray(parsed.field[key])) field[key] = Float32Array.from(parsed.field[key]);
    }

    if (typeof field.latCount !== 'number' || typeof field.lonCount !== 'number') return null;
    if (!Array.isArray(field.times) || !field.times.length) return null;
    if (!field.u || !field.v || field.u.length !== field.latCount * field.lonCount * field.hours) return null;

    return field;
  } catch {
    return null;
  }
}

export function writeFieldCache(source, field) {
  const store = storage();
  if (!store) return false;

  try {
    const payload = {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      field: { ...field },
    };

    for (const key of TYPED_KEYS) {
      if (field[key] instanceof Float32Array) payload.field[key] = Array.from(field[key]);
    }

    store.setItem(CACHE_PREFIX + source, JSON.stringify(payload));
    return true;
  } catch {
    // Quota exceeded. The field still works in memory, so drop any stale
    // entry and carry on without caching rather than failing the load.
    try {
      store.removeItem(CACHE_PREFIX + source);
    } catch {
      /* nothing further to do */
    }
    return false;
  }
}

export function clearFieldCache() {
  const store = storage();
  if (!store) return;

  try {
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (key?.startsWith(CACHE_PREFIX)) store.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

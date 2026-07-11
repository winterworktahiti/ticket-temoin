const TRIPS_KEY = "ticket-temoin:trips";
const FREQUENT_KEY = "ticket-temoin:frequent";
const CURRENT_ITEMS_KEY = "ticket-temoin:current-items";

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: non-critical, skip silently.
  }
}

export function getTrips() {
  return readJson(TRIPS_KEY, []);
}

export function saveTrip(trip) {
  const trips = getTrips();
  trips.unshift(trip);
  writeJson(TRIPS_KEY, trips.slice(0, 30));
}

export function clearTrips() {
  writeJson(TRIPS_KEY, []);
}

export function getCurrentItems() {
  return readJson(CURRENT_ITEMS_KEY, []);
}

export function saveCurrentItems(items) {
  writeJson(CURRENT_ITEMS_KEY, items);
}

export function clearCurrentItems() {
  writeJson(CURRENT_ITEMS_KEY, []);
}

export function getFrequentItems() {
  return readJson(FREQUENT_KEY, []);
}

export function recordItemUsage(name, price) {
  const trimmedName = name.trim();
  if (!trimmedName) return;
  const items = getFrequentItems();
  const existingIndex = items.findIndex(
    (item) => item.name.toLowerCase() === trimmedName.toLowerCase(),
  );
  if (existingIndex >= 0) {
    items[existingIndex] = {
      ...items[existingIndex],
      price,
      count: items[existingIndex].count + 1,
      lastUsed: new Date().toISOString(),
    };
  } else {
    items.push({ name: trimmedName, price, count: 1, lastUsed: new Date().toISOString() });
  }
  items.sort((a, b) => b.count - a.count);
  writeJson(FREQUENT_KEY, items.slice(0, 12));
}

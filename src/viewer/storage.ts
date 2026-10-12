// localStorage persistence for camera framing and studio preset. Every access is guarded:
// storage can be unavailable (private window, blocked site data) and stored shapes can be stale.

const PREFIX = 'david-print.';

export function loadStored<T extends object>(key: string, defaults: T): T {
  if (new URLSearchParams(location.search).has('fresh')) return structuredClone(defaults);
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) return mergeDefaults(structuredClone(defaults), JSON.parse(raw));
  } catch {
    /* fall through to defaults */
  }
  return structuredClone(defaults);
}

export function saveStored(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** Copies values from `stored` onto `defaults`, keeping only keys (and types) that defaults knows. */
function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (typeof defaults !== 'object' || defaults === null || typeof stored !== 'object' || stored === null) {
    return typeof stored === typeof defaults ? (stored as T) : defaults;
  }
  if (Array.isArray(defaults)) {
    return Array.isArray(stored) && stored.length === defaults.length ? (stored as T) : defaults;
  }
  const out = defaults as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    if (k in (stored as object)) out[k] = mergeDefaults(out[k], (stored as Record<string, unknown>)[k]);
  }
  return out as T;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt('Copy:', text);
  }
}

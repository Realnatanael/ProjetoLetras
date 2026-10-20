import { normalize, parseLrc } from "./library.js";

const CLIENT = "ProjetoLetras v1.1.0 (local personal use)";
const BASE = "https://lrclib.net/api";

function headers() {
  return {
    Accept: "application/json",
    "Lrclib-Client": CLIENT,
    "X-User-Agent": CLIENT,
  };
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

async function request(path) {
  const response = await fetch(`${BASE}${path}`, { headers: headers() });
  if (response.status === 404) return null;
  if (response.status === 429) {
    const wait = Number(response.headers.get("Retry-After") || 5);
    const error = new Error(`LRCLIB limitou as buscas. Tente de novo em ${wait}s.`);
    error.code = "rate_limit";
    error.retryAfter = wait;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`LRCLIB respondeu ${response.status}.`);
    error.code = "http";
    throw error;
  }
  return response.json();
}

function score(candidate, artist, title, duration) {
  let points = 0;
  if (normalize(candidate.trackName) === normalize(title)) points += 5;
  else if (normalize(candidate.trackName).includes(normalize(title)) || normalize(title).includes(normalize(candidate.trackName))) points += 2;

  if (normalize(candidate.artistName) === normalize(artist)) points += 5;
  else if (normalize(candidate.artistName).includes(normalize(artist)) || normalize(artist).includes(normalize(candidate.artistName))) points += 2;

  if (duration > 0 && Number(candidate.duration) > 0) {
    const gap = Math.abs(Number(candidate.duration) - duration);
    if (gap <= 2) points += 4;
    else if (gap <= 5) points += 2;
    else if (gap > 12) points -= 3;
  }

  if (candidate.syncedLyrics) points += 3;
  else if (candidate.plainLyrics) points += 1;
  if (candidate.instrumental) points -= 5;
  return points;
}

function toLines(record) {
  if (!record || record.instrumental) return [];
  if (record.syncedLyrics) {
    const timed = parseLrc(record.syncedLyrics);
    if (timed.length) return timed;
  }
  if (!record.plainLyrics) return [];
  return String(record.plainLyrics)
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({ t: index * 4, text }));
}

export async function fetchLyrics({ artist, title, album, duration }) {
  const trackName = String(title || "").trim();
  const artistName = String(artist || "").trim();
  if (!trackName || !artistName) {
    return { status: "invalid", lines: [], record: null };
  }

  const rounded = duration > 0 ? Math.round(duration) : undefined;
  const exactQuery = query({
    track_name: trackName,
    artist_name: artistName,
    album_name: album || undefined,
    duration: rounded,
  });

  let record = await request(`/get?${exactQuery}`);

  if (!record && rounded) {
    record = await request(
      `/get?${query({
        track_name: trackName,
        artist_name: artistName,
        album_name: album || undefined,
      })}`,
    );
  }

  if (!record) {
    const results = await request(
      `/search?${query({
        track_name: trackName,
        artist_name: artistName,
      })}`,
    );
    if (Array.isArray(results) && results.length) {
      record = [...results].sort((a, b) => score(b, artistName, trackName, rounded || 0) - score(a, artistName, trackName, rounded || 0))[0];
      if (score(record, artistName, trackName, rounded || 0) < 4) record = null;
    }
  }

  if (!record) return { status: "missing", lines: [], record: null };
  if (record.instrumental) return { status: "instrumental", lines: [], record };

  const lines = toLines(record);
  if (!lines.length) return { status: "missing", lines: [], record };
  return {
    status: record.syncedLyrics ? "synced" : "plain",
    lines,
    record,
  };
}

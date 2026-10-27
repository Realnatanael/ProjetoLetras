import { normalize, parseLrc } from "./library.js";

const CLIENT = "ProjetoLetras v1.3.0 (local personal use)";
const BASE = "https://lrclib.net/api";
const EDITION_RE = /\b(remix|live|acoustic|ac[uú]stic[oa]|radio edit|slowed|sped up|karaoke|cover)\b/gi;

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

function canonEdition(tag) {
  const clean = tag.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ");
  if (clean.startsWith("acustic")) return "acoustic";
  return clean;
}

function editionTags(value) {
  const found = String(value || "").match(EDITION_RE) || [];
  return new Set(found.map(canonEdition));
}

function editionClash(queryText, candidateText) {
  const query = editionTags(queryText);
  const candidate = editionTags(candidateText);
  if (!query.size && candidate.size) return true;
  for (const tag of query) {
    if (!candidate.has(tag)) return true;
  }
  return false;
}

function score(candidate, artist, title, duration) {
  let points = 0;
  const candidateTitle = normalize(candidate.trackName);
  const wantedTitle = normalize(title);
  if (candidateTitle === wantedTitle) points += 5;
  else if (candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle)) points += 2;

  const candidateArtist = normalize(candidate.artistName);
  const wantedArtist = normalize(artist);
  if (candidateArtist === wantedArtist) points += 5;
  else if (candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist)) points += 2;

  if (duration > 0 && Number(candidate.duration) > 0) {
    const gap = Math.abs(Number(candidate.duration) - duration);
    if (gap <= 2) points += 4;
    else if (gap <= 5) points += 2;
    else if (gap > 12) points -= 3;
  }

  if (candidate.syncedLyrics) points += 3;
  else if (candidate.plainLyrics) points += 1;
  if (candidate.instrumental) points -= 5;

  const queryEdition = editionTags(title);
  const candidateEdition = editionTags(`${candidate.trackName || ""} ${candidate.albumName || ""}`);
  if (!queryEdition.size && candidateEdition.size) points -= 4;
  else if (queryEdition.size) {
    let same = candidateEdition.size > 0;
    for (const tag of queryEdition) {
      if (!candidateEdition.has(tag)) same = false;
    }
    points += same ? 3 : -3;
  }

  return points;
}

function linesFrom(record) {
  if (!record || record.instrumental) return { synced: false, lines: [] };
  if (record.syncedLyrics) {
    const timed = parseLrc(record.syncedLyrics);
    if (timed.length) return { synced: true, lines: timed };
  }
  if (!record.plainLyrics) return { synced: false, lines: [] };
  const lines = String(record.plainLyrics)
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ t: 0, text }));
  return { synced: false, lines };
}

function outcome(record) {
  if (!record) return { status: "missing", lines: [], synced: false, record: null };
  if (record.instrumental) return { status: "instrumental", lines: [], synced: false, record };
  const parsed = linesFrom(record);
  if (!parsed.lines.length) return { status: "missing", lines: [], synced: false, record };
  return {
    status: parsed.synced ? "synced" : "plain",
    lines: parsed.lines,
    synced: parsed.synced,
    record,
  };
}

function summarize(record, artist, title, duration) {
  return {
    id: Number(record.id) || 0,
    title: record.trackName || "",
    artist: record.artistName || "",
    album: record.albumName || "",
    duration: Number(record.duration) || 0,
    instrumental: Boolean(record.instrumental),
    synced: Boolean(record.syncedLyrics),
    score: score(record, artist, title, duration),
  };
}

export async function findCandidates({ artist, title, duration, limit = 6 }) {
  const trackName = String(title || "").trim();
  const artistName = String(artist || "").trim();
  if (!trackName || !artistName) return [];

  const rounded = duration > 0 ? Math.round(duration) : 0;
  const results = await request(
    `/search?${query({
      track_name: trackName,
      artist_name: artistName,
    })}`,
  );
  if (!Array.isArray(results)) return [];

  return results
    .map((record) => summarize(record, artistName, trackName, rounded))
    .filter((item) => item.id && item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function fetchLyricsById(id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric) || numeric <= 0) return outcome(null);
  return outcome(await request(`/get/${numeric}`));
}

export async function fetchLyrics({ artist, title, album, duration }) {
  const trackName = String(title || "").trim();
  const artistName = String(artist || "").trim();
  if (!trackName || !artistName) {
    return { status: "invalid", lines: [], synced: false, record: null };
  }

  const rounded = duration > 0 ? Math.round(duration) : undefined;
  const exactQuery = query({
    track_name: trackName,
    artist_name: artistName,
    album_name: album || undefined,
    duration: rounded,
  });

  let record = await request(`/get?${exactQuery}`);
  if (record && editionClash(trackName, `${record.trackName || ""} ${record.albumName || ""}`)) record = null;

  if (!record && rounded) {
    record = await request(
      `/get?${query({
        track_name: trackName,
        artist_name: artistName,
        album_name: album || undefined,
      })}`,
    );
    if (record && editionClash(trackName, `${record.trackName || ""} ${record.albumName || ""}`)) record = null;
  }

  if (!record) {
    const results = await request(
      `/search?${query({
        track_name: trackName,
        artist_name: artistName,
      })}`,
    );
    if (Array.isArray(results) && results.length) {
      const best = [...results].sort(
        (a, b) => score(b, artistName, trackName, rounded || 0) - score(a, artistName, trackName, rounded || 0),
      )[0];
      if (score(best, artistName, trackName, rounded || 0) >= 4) record = best;
    }
  }

  return outcome(record);
}

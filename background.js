import { songKey } from "./library.js";
import { fetchLyrics } from "./lrclib.js";
import { translateTimedLines } from "./translate.js";

const MODES = new Set(["original", "translation", "both"]);
const MISS_TTL = 1000 * 60 * 60 * 12;
const TRANSLATE_RETRY_MS = 1000 * 60 * 10;
const defaults = () => ({
  songs: {},
  offsets: {},
  mode: "original",
  hidden: false,
  autoFetch: true,
  autoTranslate: true,
});

let library = defaults();
let playback = null;
let revision = 0;
let fetchStatus = { key: "", state: "idle", detail: "" };
const ports = new Set();
const inflight = new Map();

const ready = chrome.storage.local.get("library").then((stored) => {
  library = sanitize(stored.library);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.library) return;
  library = sanitize(changes.library.newValue);
  revision += 1;
  broadcast(true);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "playback") {
    playback = message.payload || null;
    void ready.then(() => {
      broadcast(false);
      void maybeFetch();
    });
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "get-state") {
    void ready.then(() => sendResponse(view()));
    return true;
  }

  if (message?.type === "patch") {
    void ready.then(async () => {
      applyPatch(message.patch || {});
      revision += 1;
      await chrome.storage.local.set({ library });
      broadcast(true);
      sendResponse({ ok: true });
      void maybeFetch();
    });
    return true;
  }

  if (message?.type === "fetch-now") {
    void ready.then(async () => {
      const result = await maybeFetch({ force: true });
      sendResponse(result || view());
    });
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "overlay") return;
  ports.add(port);
  void ready.then(() => {
    try {
      port.postMessage(messageFor(port, true));
    } catch {
      ports.delete(port);
    }
  });
  port.onDisconnect.addListener(() => ports.delete(port));
});

function looksLikeFailedTranslation(lines) {
  if (!Array.isArray(lines) || !lines.length) return false;
  return lines.some((line) => /MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS/i.test(line?.text || ""));
}

function sanitize(value) {
  const next = { ...defaults(), ...(value || {}) };
  next.songs = next.songs && typeof next.songs === "object" ? next.songs : {};
  next.offsets = next.offsets && typeof next.offsets === "object" ? next.offsets : {};
  if (!MODES.has(next.mode)) next.mode = "original";
  next.hidden = Boolean(next.hidden);
  next.autoFetch = next.autoFetch !== false;
  next.autoTranslate = next.autoTranslate !== false;
  for (const song of Object.values(next.songs)) {
    if (looksLikeFailedTranslation(song.translation)) song.translation = [];
  }
  return next;
}

function applyPatch(patch) {
  if (MODES.has(patch.mode)) library.mode = patch.mode;
  if (typeof patch.hidden === "boolean") library.hidden = patch.hidden;
  if (typeof patch.autoFetch === "boolean") library.autoFetch = patch.autoFetch;
  if (typeof patch.autoTranslate === "boolean") library.autoTranslate = patch.autoTranslate;
  if (typeof patch.offset === "number" && patch.key) {
    const offset = Math.max(-30, Math.min(30, patch.offset));
    library.offsets[patch.key] = Math.round(offset * 10) / 10;
  }
}

function currentKey() {
  if (!playback?.title) return "";
  return songKey(playback.artist, playback.title);
}

function setFetchStatus(key, state, detail = "") {
  fetchStatus = { key, state, detail };
  broadcast(false);
}

function needsOriginal(song) {
  if (!song) return true;
  if (song.source === "manual" && song.original?.length) return false;
  if (song.original?.length) return false;
  if (song.status === "missing" || song.status === "instrumental") {
    return Date.now() - Number(song.fetchedAt || 0) > MISS_TTL;
  }
  return true;
}

function needsTranslation(song) {
  if (!library.autoTranslate) return false;
  if (!song?.original?.length) return false;
  if (song.translation?.length) return false;
  if (song.source === "manual") return false;
  if (song.translationErrorAt && Date.now() - Number(song.translationErrorAt) < TRANSLATE_RETRY_MS) {
    return false;
  }
  return true;
}

async function persist() {
  revision += 1;
  await chrome.storage.local.set({ library });
  broadcast(true);
}

async function maybeFetch({ force = false } = {}) {
  await ready;
  const key = currentKey();
  if (!key || !playback?.title) return null;
  if (!force && !library.autoFetch) return null;

  const song = library.songs[key];
  const wantOriginal = force || needsOriginal(song);
  if (force && song?.translationErrorAt) {
    library.songs[key] = { ...song, translationErrorAt: 0, translationError: "" };
  }
  const wantTranslation = force
    ? library.autoTranslate && !(library.songs[key]?.translation?.length)
    : needsTranslation(library.songs[key] || song);

  if (!wantOriginal && !wantTranslation) return null;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    try {
      let current = library.songs[key] || {
        artist: playback.artist || "",
        title: playback.title || "",
        album: playback.album || "",
        original: [],
        translation: [],
        source: "lrclib",
      };

      if (wantOriginal) {
        setFetchStatus(key, "fetching", "Buscando letra na LRCLIB…");
        const result = await fetchLyrics({
          artist: playback.artist,
          title: playback.title,
          album: playback.album,
          duration: playback.duration,
        });

        current = {
          ...current,
          artist: playback.artist || current.artist || "",
          title: playback.title || current.title || "",
          album: playback.album || current.album || "",
          source: "lrclib",
          status: result.status,
          fetchedAt: Date.now(),
          original: result.lines,
        };

        if (result.status === "missing" || result.status === "instrumental" || result.status === "invalid") {
          current.translation = [];
          library.songs[key] = current;
          await persist();
          setFetchStatus(
            key,
            result.status,
            result.status === "instrumental" ? "Faixa instrumental." : "LRCLIB não encontrou essa letra.",
          );
          return view();
        }

        library.songs[key] = current;
        await persist();
        setFetchStatus(key, "found", `${result.lines.length} linhas encontradas.`);
      }

      current = library.songs[key];
      if (library.autoTranslate && current?.original?.length && !current.translation?.length) {
        setFetchStatus(key, "translating", "Traduzindo para português…");
        try {
          const translated = await translateTimedLines(current.original);
          library.songs[key] = {
            ...current,
            translation: translated,
            translatedAt: Date.now(),
            translationErrorAt: 0,
            translationError: "",
          };
          await persist();
          setFetchStatus(key, "found", "Letra e tradução prontas.");
        } catch (error) {
          library.songs[key] = {
            ...current,
            translationErrorAt: Date.now(),
            translationError: error.message || "Tradução indisponível agora.",
          };
          await persist();
          setFetchStatus(key, "found", error.message || "Letra ok; tradução indisponível agora.");
        }
      }

      return view();
    } catch (error) {
      setFetchStatus(key, "error", error.message || "Falha ao buscar a letra.");
      return view();
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}

function messageFor(port, forceLyrics) {
  const key = currentKey();
  const song = key ? library.songs[key] : null;
  const includeLyrics = forceLyrics || port._key !== key || port._rev !== revision;
  port._key = key;
  port._rev = revision;

  const message = {
    type: "state",
    playback,
    key,
    offset: key ? Number(library.offsets[key]) || 0 : 0,
    mode: library.mode,
    hidden: library.hidden,
    autoFetch: library.autoFetch,
    autoTranslate: library.autoTranslate,
    fetchStatus: fetchStatus.key === key ? fetchStatus : { key, state: "idle", detail: "" },
    matched: Boolean(song && (song.original?.length || song.translation?.length)),
  };

  if (includeLyrics) {
    message.lyrics = {
      original: song?.original || [],
      translation: song?.translation || [],
    };
  }

  return message;
}

function broadcast(forceLyrics) {
  for (const port of ports) {
    try {
      port.postMessage(messageFor(port, forceLyrics));
    } catch {
      ports.delete(port);
    }
  }
}

function view() {
  const key = currentKey();
  const song = key ? library.songs[key] : null;
  return {
    playback,
    key,
    song: song || null,
    offset: key ? Number(library.offsets[key]) || 0 : 0,
    mode: library.mode,
    hidden: library.hidden,
    autoFetch: library.autoFetch,
    autoTranslate: library.autoTranslate,
    fetchStatus: fetchStatus.key === key ? fetchStatus : { key, state: "idle", detail: "" },
    songs: Object.entries(library.songs)
      .map(([id, item]) => ({
        id,
        title: item.title || "Sem título",
        artist: item.artist || "Artista desconhecido",
        original: item.original?.length || 0,
        translation: item.translation?.length || 0,
        source: item.source || "manual",
        status: item.status || "",
      }))
      .sort((a, b) => a.title.localeCompare(b.title, "pt")),
  };
}

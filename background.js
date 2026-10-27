import { songKey } from "./library.js";
import { fetchLyrics, fetchLyricsById, findCandidates } from "./lrclib.js";
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
let playbackTabId = 0;
let revision = 0;
let fetchStatus = { key: "", state: "idle", detail: "" };
const ports = new Set();
const playbackPorts = new Set();
const inflight = new Map();
let pingTimer = 0;

const ready = chrome.storage.local.get("library").then((stored) => {
  library = sanitize(stored.library);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.library) return;
  library = sanitize(changes.library.newValue);
  revision += 1;
  broadcast(true);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "playback") {
    acceptPlayback(message.payload || null, sender.tab?.id || 0);
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

  if (message?.type === "list-candidates") {
    void ready.then(async () => {
      try {
        sendResponse({ ok: true, candidates: await listCandidates() });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || "Não consegui consultar a LRCLIB.", candidates: [] });
      }
    });
    return true;
  }

  if (message?.type === "pick-candidate") {
    void ready.then(async () => {
      try {
        sendResponse(await applyCandidate(message.id));
      } catch (error) {
        sendResponse({ ok: false, error: error.message || "Não consegui trocar a letra." });
      }
    });
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "playback") {
    watchPlaybackPort(port);
    return;
  }
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

function watchPlaybackPort(port) {
  playbackPorts.add(port);
  const tabId = port.sender?.tab?.id || 0;
  try {
    port.postMessage({ type: "ping" });
  } catch {
    playbackPorts.delete(port);
  }
  port.onDisconnect.addListener(() => {
    playbackPorts.delete(port);
    if (!tabId || tabId !== playbackTabId) return;
    setTimeout(() => {
      const stillThere = [...playbackPorts].some((item) => item.sender?.tab?.id === tabId);
      if (!stillThere && playbackTabId === tabId) {
        playback = null;
        playbackTabId = 0;
        broadcast(false);
      }
    }, 1500);
  });
  ensureClock();
}

function ensureClock() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    if (!playbackPorts.size) {
      clearInterval(pingTimer);
      pingTimer = 0;
      return;
    }
    for (const port of playbackPorts) {
      try {
        port.postMessage({ type: "ping" });
      } catch {
        playbackPorts.delete(port);
      }
    }
  }, 1000);
}

function acceptPlayback(incoming, fromTab) {
  if (!incoming?.title) {
    if (!fromTab || fromTab === playbackTabId) {
      playback = null;
      playbackTabId = 0;
    }
    return;
  }

  const fresh = playback && Date.now() - Number(playback.at) < 5000;
  if (fresh && playback.playing && playbackTabId && fromTab && fromTab !== playbackTabId && !incoming.playing) return;

  playback = incoming;
  if (fromTab) playbackTabId = fromTab;
}

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

function isSynced(song) {
  if (!song?.original?.length) return false;
  if (song.synced === false || song.status === "plain") return false;
  return true;
}

function needsOriginal(song) {
  if (!song) return true;
  if (song.picked) return false;
  if (song.source === "manual" && song.original?.length) return false;
  if (song.status === "plain" && song.original?.length) {
    return Date.now() - Number(song.fetchedAt || 0) > MISS_TTL;
  }
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
  if (song.translationSkipped === "pt") return false;
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

function foundDetail(result) {
  if (result.status === "plain") return "Letra encontrada, sem tempo sincronizado.";
  return `${result.lines.length} linhas encontradas.`;
}

function rememberLyrics(key, result, picked) {
  const previous = library.songs[key] || {
    artist: playback?.artist || "",
    title: playback?.title || "",
    album: playback?.album || "",
    original: [],
    translation: [],
  };
  library.songs[key] = {
    ...previous,
    artist: playback?.artist || previous.artist || "",
    title: playback?.title || previous.title || "",
    album: playback?.album || previous.album || "",
    source: "lrclib",
    status: result.status,
    synced: Boolean(result.synced),
    lrclibId: Number(result.record?.id) || 0,
    fetchedAt: Date.now(),
    original: result.lines,
    translation: [],
    translationSkipped: "",
    translationError: "",
    translationErrorAt: 0,
    picked: Boolean(picked),
  };
}

async function fillTranslation(key) {
  const current = library.songs[key];
  if (!needsTranslation(current)) return;

  setFetchStatus(key, "translating", "Traduzindo para português…");
  try {
    const translated = await translateTimedLines(current.original);
    const latest = library.songs[key] || current;
    library.songs[key] = {
      ...latest,
      translation: translated,
      translatedAt: Date.now(),
      translationErrorAt: 0,
      translationError: "",
      translationSkipped: "",
    };
    await persist();
    const unsynced = latest.status === "plain" || latest.synced === false;
    setFetchStatus(key, "found", unsynced ? "Letra sem sincronia. Tradução pronta." : "Letra e tradução prontas.");
  } catch (error) {
    const latest = library.songs[key] || current;
    if (error.code === "already_pt") {
      library.songs[key] = {
        ...latest,
        translation: [],
        translationSkipped: "pt",
        translationErrorAt: 0,
        translationError: "",
      };
      await persist();
      setFetchStatus(key, "found", "A letra já está em português.");
      return;
    }
    library.songs[key] = {
      ...latest,
      translationErrorAt: Date.now(),
      translationError: error.message || "Tradução indisponível agora.",
    };
    await persist();
    setFetchStatus(key, "found", error.message || "Letra ok; tradução indisponível agora.");
  }
}

function enqueue(key, task) {
  const previous = inflight.get(key) || Promise.resolve();
  const job = previous.then(task, task);
  const settled = job.then(
    () => undefined,
    () => undefined,
  );
  inflight.set(key, settled);
  settled.then(() => {
    if (inflight.get(key) === settled) inflight.delete(key);
  });
  return job;
}

async function fetchSong(key, force) {
  if (currentKey() !== key || !playback?.title) return view();
  const song = library.songs[key];
  const wantOriginal = force || needsOriginal(song);
  if (!wantOriginal && !needsTranslation(song)) return view();

  try {
    if (wantOriginal) {
      setFetchStatus(key, "fetching", "Buscando letra na LRCLIB…");
      const result = await fetchLyrics({
        artist: playback.artist,
        title: playback.title,
        album: playback.album,
        duration: playback.duration,
      });
      const failed = result.status === "missing" || result.status === "instrumental" || result.status === "invalid";
      rememberLyrics(key, result, false);
      await persist();
      if (failed) {
        setFetchStatus(
          key,
          result.status,
          result.status === "instrumental" ? "Faixa instrumental." : "LRCLIB não encontrou essa letra.",
        );
        return view();
      }
      setFetchStatus(key, "found", foundDetail(result));
    }

    await fillTranslation(key);
    return view();
  } catch (error) {
    setFetchStatus(key, "error", error.message || "Falha ao buscar a letra.");
    return view();
  }
}

async function maybeFetch({ force = false } = {}) {
  await ready;
  const key = currentKey();
  if (!key || !playback?.title) return null;
  if (!force && !library.autoFetch) return null;

  const song = library.songs[key];
  if (!force && !needsOriginal(song) && !needsTranslation(song)) return null;
  if (inflight.has(key) && !force) return inflight.get(key);
  return enqueue(key, () => fetchSong(key, force));
}

async function listCandidates() {
  const key = currentKey();
  if (!key || !playback?.title) throw new Error("Abra o Apple Music e dê play.");
  const found = await findCandidates({
    artist: playback.artist,
    title: playback.title,
    duration: playback.duration,
  });
  const currentId = Number(library.songs[key]?.lrclibId) || 0;
  const current = found.find((item) => item.id === currentId);
  const others = found.filter((item) => item.id !== currentId).slice(0, 3);
  const list = others.map((item) => ({ ...item, current: false }));
  if (current) list.unshift({ ...current, current: true });
  return list;
}

async function pickSong(key, id) {
  if (currentKey() !== key || !playback?.title) throw new Error("A faixa mudou.");
  setFetchStatus(key, "fetching", "Trocando a letra…");
  try {
    const result = await fetchLyricsById(id);
    const failed = result.status === "missing" || result.status === "instrumental" || result.status === "invalid";
    rememberLyrics(key, result, true);
    await persist();
    if (failed) {
      setFetchStatus(
        key,
        result.status === "instrumental" ? "instrumental" : "missing",
        result.status === "instrumental" ? "Faixa instrumental." : "Essa versão não tem letra.",
      );
      return view();
    }
    setFetchStatus(key, "found", result.synced ? "Letra trocada." : "Letra trocada. Esta versão não tem tempo.");
    await fillTranslation(key);
    return view();
  } catch (error) {
    setFetchStatus(key, "error", error.message || "Não consegui trocar a letra.");
    throw error;
  }
}

async function applyCandidate(id) {
  await ready;
  const key = currentKey();
  if (!key || !playback?.title) throw new Error("Abra o Apple Music e dê play.");
  const numeric = Number(id);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("Escolha uma versão.");
  return enqueue(key, () => pickSong(key, numeric));
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
    synced: isSynced(song),
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

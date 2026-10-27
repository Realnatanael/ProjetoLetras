import { parseLrc, readLrcTags, songKey } from "./library.js";

const artistInput = document.querySelector("#artist");
const titleInput = document.querySelector("#title");
const fileInput = document.querySelector("#file");
const pasteInput = document.querySelector("#paste");
const offsetInput = document.querySelector("#offset");
const autoFetchInput = document.querySelector("#auto-fetch");
const autoTranslateInput = document.querySelector("#auto-translate");
const fetchNowButton = document.querySelector("#fetch-now");
const fetchDetail = document.querySelector("#fetch-detail");
const message = document.querySelector("#message");
const statusTitle = document.querySelector("#status");
const clock = document.querySelector("#clock");
const songs = document.querySelector("#songs");
const help = document.querySelector("#help");

let importing = "original";
let state = null;
let fieldsDirty = false;
let songsSignature = "";

for (const input of [artistInput, titleInput]) {
  input.addEventListener("input", () => {
    fieldsDirty = true;
  });
}

document.querySelector("#import-original").addEventListener("click", () => pick("original"));
document.querySelector("#import-translation").addEventListener("click", () => pick("translation"));
document.querySelector("#paste-original").addEventListener("click", () => saveText(pasteInput.value, "original"));
document.querySelector("#paste-translation").addEventListener("click", () => saveText(pasteInput.value, "translation"));
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  saveText(await file.text(), importing);
});

offsetInput.addEventListener("change", async () => {
  const key = currentKey();
  if (!key || key === "|") return;
  await chrome.runtime.sendMessage({
    type: "patch",
    patch: { key, offset: Number(offsetInput.value) || 0 },
  });
  say("Ajuste salvo.");
});

autoFetchInput.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "patch",
    patch: { autoFetch: autoFetchInput.checked },
  });
});

autoTranslateInput.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "patch",
    patch: { autoTranslate: autoTranslateInput.checked },
  });
});

fetchNowButton.addEventListener("click", async () => {
  fetchNowButton.disabled = true;
  fetchDetail.textContent = "Buscando…";
  try {
    await chrome.runtime.sendMessage({ type: "fetch-now" });
    await refresh();
  } finally {
    fetchNowButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener(() => {
  void refresh();
});

function pick(kind) {
  importing = kind;
  fileInput.click();
}

function currentKey() {
  return songKey(artistInput.value, titleInput.value);
}

function format(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function say(text) {
  message.textContent = text;
}

async function libraryData() {
  const stored = await chrome.storage.local.get("library");
  const library = stored.library || {
    songs: {},
    offsets: {},
    mode: "original",
    hidden: false,
    autoFetch: true,
    autoTranslate: true,
  };
  library.songs ||= {};
  library.offsets ||= {};
  return library;
}

async function saveText(text, kind) {
  const lines = parseLrc(text);
  if (!lines.length) {
    say("Não encontrei tempos. Cada linha precisa de um marcador, como [00:12.50].");
    return;
  }

  const tags = readLrcTags(text);
  if (!fieldsDirty && !artistInput.value && !titleInput.value) {
    if (tags.artist) artistInput.value = tags.artist;
    if (tags.title) titleInput.value = tags.title;
  }

  const artist = artistInput.value.trim() || tags.artist;
  const title = titleInput.value.trim() || tags.title;
  const key = songKey(artist, title);
  if (key === "|") {
    say("Preencha o artista e a música antes de salvar.");
    return;
  }

  const library = await libraryData();
  const existing = library.songs[key] || { artist, title, original: [], translation: [] };
  existing.artist = artist;
  existing.title = title;
  existing[kind] = lines;
  existing.source = "manual";
  existing.status = "manual";
  library.songs[key] = existing;
  await chrome.storage.local.set({ library });
  pasteInput.value = "";
  fieldsDirty = false;
  say(`${kind === "original" ? "Original" : "Tradução"} salva: ${lines.length} linhas.`);
  await refresh();
}

function renderSongs(list) {
  const signature = JSON.stringify(list);
  if (signature === songsSignature) return;
  songsSignature = signature;
  songs.replaceChildren();
  help.open = list.length === 0;
  if (!list.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nenhuma letra salva ainda. Dê play no Apple Music.";
    songs.appendChild(empty);
    return;
  }

  for (const item of list) {
    const row = document.createElement("li");
    row.className = "song";
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.title;
    const meta = document.createElement("span");
    const parts = [item.artist];
    if (item.original) parts.push(`${item.original} originais`);
    if (item.translation) parts.push(`${item.translation} traduzidas`);
    if (item.status === "plain") parts.push("sem sincronia");
    if (item.source === "lrclib") parts.push("LRCLIB");
    if (item.source === "manual") parts.push("manual");
    meta.textContent = parts.join(" · ");
    text.append(name, meta);

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.type = "button";
    remove.textContent = "Excluir";
    remove.addEventListener("click", async () => {
      const library = await libraryData();
      delete library.songs[item.id];
      delete library.offsets[item.id];
      await chrome.storage.local.set({ library });
    });

    row.append(text, remove);
    songs.appendChild(row);
  }
}

function renderFetchStatus(status) {
  const map = {
    idle: "",
    fetching: "Buscando letra na LRCLIB…",
    translating: "Traduzindo para português…",
    found: status?.detail || "Letra pronta.",
    missing: status?.detail || "LRCLIB não encontrou essa letra.",
    instrumental: status?.detail || "Faixa instrumental.",
    error: status?.detail || "Falha na busca.",
  };
  fetchDetail.textContent = map[status?.state] || status?.detail || "";
}

async function refresh() {
  state = await chrome.runtime.sendMessage({ type: "get-state" });
  if (!state) return;
  const playback = state.playback;
  const fresh = playbackFresh(playback);

  if (!fresh) {
    statusTitle.textContent = "Apple Music não detectado";
    clock.textContent = "Abra music.apple.com e dê play.";
  } else {
    statusTitle.textContent = playback.title;
    const duration = playback.duration ? ` / ${format(playback.duration)}` : "";
    clock.textContent = `${playback.artist || "Artista desconhecido"} · ${playback.playing ? "tocando" : "pausado"} · ${format(shownTime(playback))}${duration}`;
    if (!fieldsDirty && document.activeElement !== artistInput && document.activeElement !== titleInput) {
      artistInput.value = playback.artist || "";
      titleInput.value = playback.title || "";
    }
  }

  if (document.activeElement !== offsetInput) offsetInput.value = String(state.offset || 0);
  if (document.activeElement !== autoFetchInput) autoFetchInput.checked = state.autoFetch !== false;
  if (document.activeElement !== autoTranslateInput) autoTranslateInput.checked = state.autoTranslate !== false;
  renderFetchStatus(state.fetchStatus);
  renderSongs(state.songs || []);
}

function playbackFresh(playback) {
  if (!playback?.title) return false;
  const age = (Date.now() - Number(playback.at || 0)) / 1000;
  if (age < 4) return true;
  return Boolean(playback.playing) && age < 45 * 60;
}

function shownTime(playback) {
  let time = Number(playback.time) || 0;
  const at = Number(playback.at) || 0;
  if (playback.playing && at > 0) {
    const elapsed = (Date.now() - at) / 1000;
    if (elapsed > 0) time += Math.min(elapsed, 45 * 60);
  }
  if (playback.duration > 0) time = Math.min(time, playback.duration);
  return time;
}

function paintClock() {
  const playback = state?.playback;
  if (playbackFresh(playback)) {
    const duration = playback.duration ? ` / ${format(playback.duration)}` : "";
    clock.textContent = `${playback.artist || "Artista desconhecido"} · ${playback.playing ? "tocando" : "pausado"} · ${format(shownTime(playback))}${duration}`;
  }
  window.requestAnimationFrame(paintClock);
}

void refresh();
window.setInterval(() => void refresh(), 1000);
paintClock();

(() => {
  const SOURCE = "projeto-letras";
  let lastSignature = "";
  let cachedMedia = null;
  let lastWalk = 0;
  let cachedMeta = { title: "", artist: "", album: "" };
  let listening = false;

  function stringProp(object, names) {
    for (const name of names) {
      const value = object?.[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function kit() {
    const musicKit = window.MusicKit;
    if (!musicKit || typeof musicKit.getInstance !== "function") return null;
    try {
      return musicKit.getInstance();
    } catch {
      return null;
    }
  }

  function isPlaying(music) {
    if (typeof music.isPlaying === "boolean") return music.isPlaying;
    const state = String(music.playbackState ?? "").toLowerCase();
    return state === "2" || state.includes("play") || state.includes("seek");
  }

  function readKit() {
    const music = kit();
    if (!music?.nowPlayingItem) return null;
    const item = music.nowPlayingItem;
    const attributes = item.attributes || {};
    const title = stringProp(attributes, ["name"]) || stringProp(item, ["title", "name"]);
    if (!title) return null;

    const durationMs = Number(attributes.durationInMillis);
    return {
      title,
      artist: stringProp(attributes, ["artistName"]) || stringProp(item, ["artistName", "artist"]),
      album: stringProp(attributes, ["albumName"]) || stringProp(item, ["albumName", "album"]),
      time: Number(music.currentPlaybackTime) || 0,
      duration: Number(music.currentPlaybackDuration) || (durationMs > 0 ? durationMs / 1000 : 0),
      playing: isPlaying(music),
      at: Date.now(),
    };
  }

  function walkMedia(root, depth, found) {
    if (!root || depth > 6) return;
    for (const element of root.querySelectorAll("audio, video")) found.push(element);
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) walkMedia(element.shadowRoot, depth + 1, found);
    }
  }

  function readDom() {
    const now = Date.now();
    if (!cachedMedia?.isConnected || now - lastWalk > 2000) {
      const found = [];
      walkMedia(document, 0, found);
      cachedMedia =
        found.find((element) => element.currentTime > 0 && !element.paused) ||
        found.find((element) => element.currentTime > 0) ||
        found[0] ||
        null;
      lastWalk = now;
      const metadata = navigator.mediaSession?.metadata;
      if (metadata?.title) {
        cachedMeta = {
          title: metadata.title || "",
          artist: metadata.artist || "",
          album: metadata.album || "",
        };
      }
    }

    if (!cachedMeta.title && !cachedMedia) return null;
    return {
      title: cachedMeta.title,
      artist: cachedMeta.artist,
      album: cachedMeta.album,
      time: Number(cachedMedia?.currentTime) || 0,
      duration: Number.isFinite(cachedMedia?.duration) ? cachedMedia.duration : 0,
      playing: Boolean(cachedMedia && !cachedMedia.paused && !cachedMedia.ended),
      at: Date.now(),
    };
  }

  function publish() {
    let payload = null;
    try {
      payload = readKit() || readDom();
    } catch {
      payload = null;
    }
    if (!payload?.title) return;

    const signature = [
      payload.title,
      payload.artist,
      payload.playing ? "1" : "0",
      payload.time.toFixed(1),
    ].join("|");
    if (signature === lastSignature) return;
    lastSignature = signature;
    window.postMessage({ source: SOURCE, payload }, location.origin);
  }

  function listen() {
    const music = kit();
    if (!music || listening || typeof music.addEventListener !== "function") return;
    listening = true;
    for (const eventName of ["nowPlayingItemDidChange", "playbackStateDidChange", "playbackTimeDidChange"]) {
      try {
        music.addEventListener(eventName, publish);
      } catch {
        // O player pode não emitir todos esses eventos.
      }
    }
  }

  window.setInterval(() => {
    listen();
    publish();
  }, 250);
})();

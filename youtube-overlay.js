(() => {
  const host = document.createElement("div");
  host.id = "projeto-letras-host";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = chrome.runtime.getURL("overlay.css");

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div id="pl-root" data-sync="line">
      <div id="pl-stage"><div id="pl-lines"></div></div>
      <p id="pl-hint" hidden></p>
      <p id="pl-sync" hidden>Letra sem tempo sincronizado</p>
      <div id="pl-hud">
        <div id="pl-bar">
          <button type="button" data-mode="original">Original</button>
          <button type="button" data-mode="translation">Tradução</button>
          <button type="button" data-mode="both">As duas</button>
          <button type="button" data-offset="-0.1" title="Atrasar a letra">−</button>
          <span id="pl-offset">0,0s</span>
          <button type="button" data-offset="0.1" title="Adiantar a letra">+</button>
          <button type="button" id="pl-hide">Ocultar</button>
          <button type="button" id="pl-reject">Não é essa</button>
        </div>
        <div id="pl-pick" hidden>
          <p id="pl-pick-label">Qual é a letra certa?</p>
          <div id="pl-options"></div>
        </div>
      </div>
    </div>
  `;
  shadow.append(style, wrapper.firstElementChild);

  const root = shadow.getElementById("pl-root");
  const stage = shadow.getElementById("pl-stage");
  const linesEl = shadow.getElementById("pl-lines");
  const hintEl = shadow.getElementById("pl-hint");
  const offsetEl = shadow.getElementById("pl-offset");
  const hideButton = shadow.getElementById("pl-hide");
  const syncEl = shadow.getElementById("pl-sync");
  const rejectButton = shadow.getElementById("pl-reject");
  const pickEl = shadow.getElementById("pl-pick");
  const pickLabel = shadow.getElementById("pl-pick-label");
  const optionsEl = shadow.getElementById("pl-options");
  const modeButtons = [...shadow.querySelectorAll("[data-mode]")];

  let playback = null;
  let lyrics = { original: [], translation: [] };
  let offset = 0;
  let mode = "original";
  let hidden = false;
  let synced = true;
  let pickOpen = false;
  let matched = false;
  let fetchStatus = { state: "idle", detail: "" };
  let key = "";
  let builtKey = "";
  let activeIndex = -1;
  let smoothTime = 0;
  let scrollY = 0;
  let placedParent = null;
  let scrollRaf = 0;
  let hudVisible = false;
  let hudTimer = 0;
  const hudEl = shadow.getElementById("pl-hud");

  function activeLines() {
    if (mode === "translation" && lyrics.translation.length) return lyrics.translation;
    if (lyrics.original.length) return lyrics.original;
    return lyrics.translation;
  }

  function lineIndex(lines, time) {
    let index = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].t <= time) index = i;
      else break;
    }
    return index;
  }

  const MAX_EXTRAPOLATE = 45 * 60;

  function trackTime() {
    if (!playback) return 0;
    let target = Number(playback.time) || 0;
    const at = Number(playback.at) || 0;
    if (playback.playing && at > 0) {
      const elapsed = (Date.now() - at) / 1000;
      if (elapsed > 0) target += Math.min(elapsed, MAX_EXTRAPOLATE);
    }
    const duration = Number(playback.duration) || 0;
    if (duration > 0) target = Math.min(target, Math.max(duration - 0.05, 0));
    return Math.max(0, target);
  }

  function displayedTime() {
    if (!playback) return smoothTime;
    const target = trackTime() + offset;
    const gap = target - smoothTime;
    if (!playback.playing || Math.abs(gap) > 0.45) smoothTime = target;
    else smoothTime += gap * 0.35;
    return smoothTime;
  }

  function plainIndex(lines) {
    const duration = Number(playback?.duration) || 0;
    if (duration <= 0 || !lines.length) return 0;
    const ratio = Math.min(0.999, Math.max(0, trackTime() / duration));
    return Math.min(lines.length - 1, Math.floor(ratio * lines.length));
  }

  function rebuild(lines) {
    const signature = `${key}|${mode}|${synced ? "s" : "p"}|${lines.map((line) => `${line.t}|${line.text}`).join("\n")}`;
    if (signature === builtKey) return false;
    builtKey = signature;
    activeIndex = -1;
    linesEl.replaceChildren();
    for (const line of lines) {
      const paragraph = document.createElement("p");
      paragraph.className = "pl-line";
      paragraph.dataset.distance = "far";
      paragraph.textContent = line.text;
      linesEl.appendChild(paragraph);
    }
    return true;
  }

  function targetFor(index) {
    const line = linesEl.children[index];
    if (!line || !stage?.clientHeight) return scrollY;
    // With a transform on #pl-lines, offsetTop stays relative to that container
    // and ignores each line's own scale/blur transforms.
    return stage.clientHeight * 0.34 - line.offsetTop - line.offsetHeight * 0.45;
  }

  function applyScroll(y, instant) {
    scrollY = y;
    if (instant) {
      linesEl.classList.add("is-snapping");
      linesEl.style.transform = `translate3d(0, ${y}px, 0)`;
      void linesEl.offsetHeight;
      linesEl.classList.remove("is-snapping");
      return;
    }
    linesEl.classList.remove("is-snapping");
    linesEl.style.transform = `translate3d(0, ${y}px, 0)`;
  }

  function scrollToIndex(index, instant = false) {
    if (scrollRaf) {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = 0;
    }

    const run = () => {
      scrollRaf = 0;
      if (!linesEl.children[index] || !stage?.clientHeight) return;
      const y = targetFor(index);
      const jump = Math.abs(y - scrollY) > stage.clientHeight * 0.95;
      applyScroll(y, instant || jump || activeIndex < 0);
    };

    // Wait one frame so distance/active classes can settle before measuring.
    scrollRaf = requestAnimationFrame(run);
  }

  function subtitle(time, index) {
    if (mode !== "both" || !lyrics.translation.length || !lyrics.original.length) return "";
    if (!synced) return lyrics.translation[index]?.text || "";
    const found = lineIndex(lyrics.translation, time);
    return found >= 0 ? lyrics.translation[found].text : "";
  }

  function clearLines() {
    if (!builtKey && linesEl.childElementCount === 0) return;
    builtKey = "";
    activeIndex = -1;
    linesEl.replaceChildren();
  }

  function updateLineStates(index, translation, changed) {
    const nodes = linesEl.children;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const distance = Math.abs(i - index);
      const nextDistance = distance >= 4 ? "far" : String(distance);
      if (node.dataset.distance !== nextDistance) node.dataset.distance = nextDistance;
      node.classList.toggle("is-past", i < index);
      node.classList.toggle("is-active", i === index);

      if (changed) {
        if (i === index) {
          node.classList.remove("is-fresh");
          void node.offsetWidth;
          node.classList.add("is-fresh");
        } else {
          node.classList.remove("is-fresh");
        }
      }

      const sub = node.querySelector(".pl-sub");
      if (i === index && translation) {
        const label = sub || document.createElement("span");
        label.className = "pl-sub";
        if (label.textContent !== translation) label.textContent = translation;
        if (!sub) node.appendChild(label);
      } else if (sub) {
        sub.remove();
      }
    }
  }

  function paint() {
    const onWatch = location.pathname === "/watch";
    host.hidden = !onWatch;
    if (!onWatch) return;

    place();
    const lines = activeLines();
    root.dataset.hidden = hidden ? "true" : "false";
    root.dataset.hud = hudVisible ? "true" : "false";
    hideButton.textContent = hidden ? "Mostrar" : "Ocultar";
    offsetEl.textContent = `${offset > 0 ? "+" : ""}${offset.toFixed(1).replace(".", ",")}s`;

    root.dataset.sync = synced ? "line" : "plain";
    rejectButton.setAttribute("aria-expanded", pickOpen ? "true" : "false");

    for (const button of modeButtons) {
      const needsTranslation = button.dataset.mode !== "original";
      button.disabled = needsTranslation && lyrics.translation.length === 0;
      button.setAttribute("aria-pressed", button.dataset.mode === mode ? "true" : "false");
    }

    if (!playback?.title) {
      clearLines();
      syncEl.hidden = true;
      showHint("Abra o Apple Music em outra aba e dê play. Deixe este vídeo mudo.");
      return;
    }
    if (lines.length === 0) {
      clearLines();
      syncEl.hidden = true;
      const label = playback.artist ? `${playback.artist} — ${playback.title}` : playback.title;
      if (fetchStatus.state === "fetching") showHint(`Buscando letra de ${label}…`);
      else if (fetchStatus.state === "translating") showHint("Traduzindo a letra…");
      else if (fetchStatus.state === "missing" || fetchStatus.state === "instrumental") {
        showHint(fetchStatus.detail || `LRCLIB não encontrou letra para ${label}.`);
      } else if (fetchStatus.state === "error") {
        showHint(fetchStatus.detail || "Falha ao buscar a letra.");
      } else {
        showHint(matched ? "Esta faixa ainda não tem letra." : `Sem letra para ${label}. A busca começa sozinha.`);
      }
      return;
    }

    hintEl.hidden = true;
    syncEl.hidden = hidden || synced;
    if (!synced) {
      syncEl.textContent = Number(playback.duration) > 0
        ? "Letra sem tempo sincronizado. O texto acompanha a duração da faixa."
        : "Letra sem tempo sincronizado.";
    }
    const time = displayedTime();
    const rebuilt = rebuild(lines);
    if (!stage?.clientHeight) return;

    const index = synced ? Math.max(0, lineIndex(lines, time)) : plainIndex(lines);
    const changed = index !== activeIndex;
    updateLineStates(index, subtitle(time, index), changed);

    if (rebuilt) {
      activeIndex = index;
      scrollToIndex(index, true);
      return;
    }

    if (changed) {
      activeIndex = index;
      scrollToIndex(index, false);
    }
  }

  function showHint(text) {
    hintEl.hidden = hidden;
    hintEl.textContent = text;
  }

  function fullscreenHost() {
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fullscreen) return document.documentElement;
    if (fullscreen instanceof HTMLMediaElement) return fullscreen.parentElement || document.documentElement;
    return fullscreen;
  }

  function place() {
    const parent = fullscreenHost();
    if (placedParent === parent && host.isConnected) return;
    parent.appendChild(host);
    placedParent = parent;
  }

  function patch(partial) {
    chrome.runtime.sendMessage({ type: "patch", patch: { key, ...partial } }).catch(() => {});
  }

  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      mode = button.dataset.mode;
      builtKey = "";
      patch({ mode });
    });
  }

  for (const button of shadow.querySelectorAll("[data-offset]")) {
    button.addEventListener("click", () => {
      offset = Math.max(-30, Math.min(30, Math.round((offset + Number(button.dataset.offset)) * 10) / 10));
      patch({ offset });
    });
  }

  hideButton.addEventListener("click", () => {
    hidden = !hidden;
    patch({ hidden });
  });

  function showHud() {
    window.clearTimeout(hudTimer);
    hudVisible = true;
    root.dataset.hud = "true";
  }

  function hideHudSoon() {
    if (pickOpen) return;
    window.clearTimeout(hudTimer);
    hudTimer = window.setTimeout(() => {
      hudVisible = false;
      root.dataset.hud = "false";
    }, 700);
  }

  function closePick() {
    pickOpen = false;
    pickEl.hidden = true;
    rejectButton.setAttribute("aria-expanded", "false");
  }

  function formatDuration(seconds) {
    const safe = Math.round(Number(seconds) || 0);
    if (!safe) return "";
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function renderCandidates(list, error) {
    optionsEl.replaceChildren();
    pickLabel.textContent = "Qual é a letra certa?";
    if (error) {
      optionsEl.textContent = error;
      return;
    }
    if (!list.length || list.every((item) => item.current)) {
      optionsEl.textContent = "A LRCLIB não tem outra versão parecida.";
      return;
    }

    for (const item of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pl-option";
      const title = [item.artist, item.title].filter(Boolean).join(" — ");
      const meta = [];
      if (item.album) meta.push(item.album);
      const duration = formatDuration(item.duration);
      if (duration) meta.push(duration);
      if (item.instrumental) meta.push("instrumental");
      else meta.push(item.synced ? "sincronizada" : "sem tempo");
      if (item.current) meta.push("em uso");
      button.textContent = meta.length ? `${title} · ${meta.join(" · ")}` : title;
      button.disabled = Boolean(item.current);
      button.setAttribute("aria-current", item.current ? "true" : "false");
      button.addEventListener("click", () => chooseCandidate(item.id));
      optionsEl.appendChild(button);
    }
  }

  async function chooseCandidate(id) {
    optionsEl.textContent = "Trocando a letra…";
    try {
      const response = await chrome.runtime.sendMessage({ type: "pick-candidate", id });
      if (response?.ok === false) {
        optionsEl.textContent = response.error || "Não consegui trocar a letra.";
        return;
      }
      closePick();
    } catch {
      optionsEl.textContent = "Não consegui trocar a letra.";
    }
  }

  async function togglePick() {
    if (pickOpen) {
      closePick();
      return;
    }
    pickOpen = true;
    pickEl.hidden = false;
    showHud();
    pickLabel.textContent = "Qual é a letra certa?";
    optionsEl.textContent = "Buscando outras versões…";
    try {
      const response = await chrome.runtime.sendMessage({ type: "list-candidates" });
      renderCandidates(response?.candidates || [], response?.ok === false ? response.error : "");
    } catch {
      renderCandidates([], "Não consegui consultar a LRCLIB.");
    }
  }

  rejectButton.addEventListener("click", () => {
    void togglePick();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !pickOpen) return;
    event.stopPropagation();
    closePick();
  }, true);

  function onMouseMove(event) {
    if (host.hidden) return;
    if (event.clientY <= 88) showHud();
    else if (!hudEl.matches(":hover")) hideHudSoon();
  }

  document.addEventListener("mousemove", onMouseMove, { passive: true });
  hudEl.addEventListener("mouseenter", showHud);
  hudEl.addEventListener("mouseleave", hideHudSoon);

  function applyState(message) {
    const nextKey = message.key || "";
    if (nextKey !== key) {
      smoothTime = Number(message.playback?.time) || 0;
      activeIndex = -1;
      closePick();
    }
    playback = message.playback;
    key = nextKey;
    offset = Number(message.offset) || 0;
    mode = message.mode || "original";
    hidden = Boolean(message.hidden);
    matched = Boolean(message.matched);
    if (typeof message.synced === "boolean") synced = message.synced;
    fetchStatus = message.fetchStatus || { state: "idle", detail: "" };
    if (message.lyrics) lyrics = message.lyrics;
  }

  function connect() {
    try {
      const port = chrome.runtime.connect({ name: "overlay" });
      port.onMessage.addListener(applyState);
      port.onDisconnect.addListener(() => window.setTimeout(connect, 400));
    } catch {
      window.setTimeout(connect, 1000);
    }
  }

  connect();
  place();
  const stageObserver = new ResizeObserver(() => {
    if (activeIndex >= 0) scrollToIndex(activeIndex, true);
  });
  stageObserver.observe(stage);
  document.addEventListener("fullscreenchange", place);
  document.addEventListener("webkitfullscreenchange", place);
  document.addEventListener("yt-navigate-finish", () => {
    builtKey = "";
    activeIndex = -1;
    place();
  });

  function tick() {
    paint();
    window.requestAnimationFrame(tick);
  }
  tick();
})();

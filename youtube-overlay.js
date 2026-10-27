(() => {
  const host = document.createElement("div");
  host.id = "projeto-letras-host";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = chrome.runtime.getURL("overlay.css");

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div id="pl-root">
      <div id="pl-stage"><div id="pl-lines"></div></div>
      <p id="pl-hint" hidden></p>
      <div id="pl-hud">
        <button type="button" data-mode="original">Original</button>
        <button type="button" data-mode="translation">Tradução</button>
        <button type="button" data-mode="both">As duas</button>
        <button type="button" data-offset="-0.1" title="Atrasar a letra">−</button>
        <span id="pl-offset">0,0s</span>
        <button type="button" data-offset="0.1" title="Adiantar a letra">+</button>
        <button type="button" id="pl-hide">Ocultar</button>
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
  const modeButtons = [...shadow.querySelectorAll("[data-mode]")];

  let playback = null;
  let lyrics = { original: [], translation: [] };
  let offset = 0;
  let mode = "original";
  let hidden = false;
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

  function displayedTime() {
    if (!playback) return smoothTime;
    let target = Number(playback.time) || 0;
    if (playback.playing) {
      const elapsed = (Date.now() - playback.at) / 1000;
      if (elapsed >= 0 && elapsed < 3) target += elapsed;
    }
    target += offset;
    const gap = target - smoothTime;
    if (!playback.playing || Math.abs(gap) > 0.45) smoothTime = target;
    else smoothTime += gap * 0.35;
    return smoothTime;
  }

  function rebuild(lines) {
    const signature = `${key}|${mode}|${lines.map((line) => `${line.t}|${line.text}`).join("\n")}`;
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

  function subtitle(time) {
    if (mode !== "both" || !lyrics.translation.length || !lyrics.original.length) return "";
    const index = lineIndex(lyrics.translation, time);
    return index >= 0 ? lyrics.translation[index].text : "";
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

    for (const button of modeButtons) {
      const needsTranslation = button.dataset.mode !== "original";
      button.disabled = needsTranslation && lyrics.translation.length === 0;
      button.setAttribute("aria-pressed", button.dataset.mode === mode ? "true" : "false");
    }

    if (!playback?.title) {
      clearLines();
      showHint("Abra o Apple Music em outra aba e dê play. Deixe este vídeo mudo.");
      return;
    }
    if (lines.length === 0) {
      clearLines();
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
    const time = displayedTime();
    const rebuilt = rebuild(lines);
    if (!stage?.clientHeight) return;

    const index = Math.max(0, lineIndex(lines, time));
    const changed = index !== activeIndex;
    updateLineStates(index, subtitle(time), changed);

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
    window.clearTimeout(hudTimer);
    hudTimer = window.setTimeout(() => {
      hudVisible = false;
      root.dataset.hud = "false";
    }, 700);
  }

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
    }
    playback = message.playback;
    key = nextKey;
    offset = Number(message.offset) || 0;
    mode = message.mode || "original";
    hidden = Boolean(message.hidden);
    matched = Boolean(message.matched);
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
// O código inteiro é encapsulado em uma IIFE (Immediately Invoked Function Expression) para evitar poluição do escopo global. Ele cria uma sobreposição de letras para vídeos do YouTube, permitindo que os usuários vejam letras originais, traduções ou ambas, com opções de ajuste de tempo e visibilidade. A sobreposição é atualizada dinamicamente com base no estado da reprodução e nas interações do usuário.

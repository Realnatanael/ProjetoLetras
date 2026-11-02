const generation = (window.__plBridgeGen = (window.__plBridgeGen || 0) + 1);

function alive() {
  return window.__plBridgeGen === generation && Boolean(chrome.runtime?.id);
}

function connect() {
  if (window !== window.top) return;
  if (!alive()) return;

  let port;
  try {
    port = chrome.runtime.connect({ name: "playback" });
  } catch {
    window.setTimeout(connect, 1000);
    return;
  }

  port.onMessage.addListener((message) => {
    if (!alive() || message?.type !== "ping") return;
    window.postMessage({ source: "projeto-letras-host", type: "ping" }, location.origin);
  });
  port.onDisconnect.addListener(() => {
    if (!alive()) return;
    window.setTimeout(connect, 500);
  });
}

window.addEventListener("message", (event) => {
  if (!alive()) return;
  if (event.origin !== location.origin || event.source !== window) return;
  if (event.data?.source !== "projeto-letras" || !event.data.payload) return;
  chrome.runtime.sendMessage({ type: "playback", payload: event.data.payload }, () => {
    void chrome.runtime.lastError;
  });
});

connect();

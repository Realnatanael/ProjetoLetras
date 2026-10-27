function connect() {
  if (window !== window.top) return;
  if (!chrome.runtime?.id) {
    window.setTimeout(connect, 1000);
    return;
  }

  let port;
  try {
    port = chrome.runtime.connect({ name: "playback" });
  } catch {
    window.setTimeout(connect, 1000);
    return;
  }

  port.onMessage.addListener((message) => {
    if (message?.type !== "ping") return;
    window.postMessage({ source: "projeto-letras-host", type: "ping" }, location.origin);
  });
  port.onDisconnect.addListener(() => {
    window.setTimeout(connect, 500);
  });
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== window) return;
  if (event.data?.source !== "projeto-letras" || !event.data.payload) return;
  if (!chrome.runtime?.id) return;
  chrome.runtime.sendMessage({ type: "playback", payload: event.data.payload }, () => {
    void chrome.runtime.lastError;
  });
});

connect();

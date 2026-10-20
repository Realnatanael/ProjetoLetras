window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== window) return;
  if (event.data?.source !== "projeto-letras" || !event.data.payload) return;
  if (!chrome.runtime?.id) return;
  chrome.runtime.sendMessage({ type: "playback", payload: event.data.payload }, () => {
    void chrome.runtime.lastError;
  });
});

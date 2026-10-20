const MAX_CHARS = 420;

function isQuotaText(text) {
  return /MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS|quota/i.test(String(text || ""));
}

function parseGoogle(data) {
  if (!Array.isArray(data)) return "";
  if (Array.isArray(data[0]) && Array.isArray(data[0][0])) {
    return data[0].map((row) => (row && row[0]) || "").join("");
  }
  if (Array.isArray(data[0]) && typeof data[0][0] === "string") {
    return data[0][0];
  }
  return "";
}

async function translateGoogleGtx(text) {
  const url = `https://translate.googleapis.com/translate_a/single?${new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: "pt",
    dt: "t",
    q: text,
  })}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Translate respondeu ${response.status}.`);
  const translated = parseGoogle(await response.json()).trim();
  if (!translated) throw new Error("Tradução vazia.");
  return translated;
}

async function translateGoogleChrome(text) {
  const url = `https://clients5.google.com/translate_a/t?${new URLSearchParams({
    client: "dict-chrome-ex",
    sl: "auto",
    tl: "pt",
    q: text,
  })}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Translate respondeu ${response.status}.`);
  const translated = parseGoogle(await response.json()).trim();
  if (!translated) throw new Error("Tradução vazia.");
  return translated;
}

async function translateMyMemory(text) {
  const url = `https://api.mymemory.translated.net/get?${new URLSearchParams({
    q: text,
    langpair: "en|pt",
  })}`;
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Tradução falhou (${response.status}).`);
    error.code = response.status === 429 ? "rate_limit" : "http";
    throw error;
  }
  const data = await response.json();
  const translated = data?.responseData?.translatedText;
  if (!translated || isQuotaText(translated) || String(data.responseStatus) === "429") {
    const error = new Error("Limite diário da tradução gratuita.");
    error.code = "rate_limit";
    throw error;
  }
  return String(translated);
}

async function translateChunk(text) {
  const providers = [translateGoogleGtx, translateGoogleChrome, translateMyMemory];
  let lastError = null;
  for (const provider of providers) {
    try {
      const translated = await provider(text);
      if (translated && !isQuotaText(translated)) return translated;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Nenhum serviço de tradução respondeu.");
}

function chunkLines(lines) {
  const chunks = [];
  let bucket = [];
  let size = 0;

  for (const line of lines) {
    const next = line.text.length + (bucket.length ? 1 : 0);
    if (bucket.length && size + next > MAX_CHARS) {
      chunks.push(bucket);
      bucket = [];
      size = 0;
    }
    bucket.push(line);
    size += next;
  }
  if (bucket.length) chunks.push(bucket);
  return chunks;
}

export async function translateTimedLines(lines) {
  if (!lines?.length) return [];
  const translated = [];

  for (const group of chunkLines(lines)) {
    const payload = group.map((line) => line.text).join("\n");
    const result = await translateChunk(payload);
    const parts = result.split(/\r?\n/);
    for (let i = 0; i < group.length; i += 1) {
      translated.push({
        t: group[i].t,
        text: (parts[i] || group[i].text).trim() || group[i].text,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return translated;
}

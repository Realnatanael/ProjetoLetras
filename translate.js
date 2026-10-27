const MAX_CHARS = 420;
const MAX_LINES = 6;
const LINE_PAUSE_MS = 80;

const MYMEMORY_LANG = {
  zh: "zh-CN",
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (typeof data[0] === "string") return data[0];
  return "";
}

function languageCode(value) {
  const code = String(value || "").trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-|_|$)/.test(code)) return "";
  return code.slice(0, 2);
}

function scriptLanguage(text) {
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  return "";
}

function countTokens(text, patterns) {
  let score = 0;
  for (const pattern of patterns) {
    const found = text.match(pattern);
    if (found) score += found.length;
  }
  return score;
}

function romanceLanguage(text) {
  const sample = text.toLowerCase();
  const pt = countTokens(sample, [
    /não/g,
    /você/g,
    /voce/g,
    /\bpra\b/g,
    /também/g,
    /tambem/g,
    /então/g,
    /entao/g,
    /\bsão\b/g,
    /[ãõ]/g,
  ]);
  const es = countTokens(sample, [/ñ/g, /¿/g, /¡/g, /ción/g, /\bquiero\b/g, /\bcorazón\b/g]);
  if (pt >= 3 && pt >= es + 2) return "pt";
  if (es >= 3 && es > pt) return "es";
  return "";
}

async function googleRaw(text) {
  const url = `https://translate.googleapis.com/translate_a/single?${new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: "pt",
    dt: "t",
    q: text,
  })}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Translate respondeu ${response.status}.`);
  return response.json();
}

async function detectLanguage(text) {
  const script = scriptLanguage(text);
  if (script) return script;
  try {
    const data = await googleRaw(text.slice(0, 400));
    const detected = languageCode(data?.[2]);
    if (detected) return detected;
  } catch {
    // Segue com a heurística quando o Google não responde.
  }
  return romanceLanguage(text);
}

async function translateGoogleGtx(text) {
  const translated = parseGoogle(await googleRaw(text)).trim();
  if (!translated || isQuotaText(translated)) throw new Error("Tradução vazia.");
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
  if (!translated || isQuotaText(translated)) throw new Error("Tradução vazia.");
  return translated;
}

async function translateMyMemory(text, sourceLang) {
  const sl = MYMEMORY_LANG[sourceLang] || sourceLang;
  if (!sl || sl === "pt") throw new Error("Idioma de origem desconhecido.");
  const url = `https://api.mymemory.translated.net/get?${new URLSearchParams({
    q: text,
    langpair: `${sl}|pt`,
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

async function translateChunk(text, sourceLang) {
  const providers = [
    translateGoogleGtx,
    translateGoogleChrome,
    (value) => translateMyMemory(value, sourceLang),
  ];
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
    if (bucket.length && (bucket.length >= MAX_LINES || size + next > MAX_CHARS)) {
      chunks.push(bucket);
      bucket = [];
      size = 0;
    }
    bucket.push(line);
    size += line.text.length + 1;
  }
  if (bucket.length) chunks.push(bucket);
  return chunks;
}

function splitTranslated(text, expected) {
  const parts = String(text || "").split(/\r?\n/).map((line) => line.trim());
  while (parts.length > expected && parts[parts.length - 1] === "") parts.pop();
  while (parts.length > expected && parts[0] === "") parts.shift();
  return parts;
}

async function translateGroup(group, sourceLang) {
  if (group.length === 1) {
    const text = await translateChunk(group[0].text, sourceLang);
    return [text.trim() || group[0].text];
  }

  try {
    const result = await translateChunk(group.map((line) => line.text).join("\n"), sourceLang);
    const parts = splitTranslated(result, group.length);
    if (parts.length === group.length && parts.every((part) => part && !isQuotaText(part))) return parts;
  } catch {
    // O bloco veio com outra quantidade de linhas; traduz uma a uma.
  }

  const lines = [];
  for (const line of group) {
    try {
      const text = await translateChunk(line.text, sourceLang);
      lines.push(text.trim() || line.text);
    } catch {
      lines.push(line.text);
    }
    await wait(LINE_PAUSE_MS);
  }
  return lines;
}

export async function translateTimedLines(lines) {
  if (!lines?.length) return [];
  const sample = lines.map((line) => line.text).join("\n").slice(0, 900);
  const lang = await detectLanguage(sample);
  if (lang === "pt") {
    const error = new Error("A letra já está em português.");
    error.code = "already_pt";
    throw error;
  }

  const translated = [];
  let changed = 0;
  for (const group of chunkLines(lines)) {
    const parts = await translateGroup(group, lang);
    for (let i = 0; i < group.length; i += 1) {
      const text = (parts[i] || group[i].text).trim() || group[i].text;
      if (text !== group[i].text) changed += 1;
      translated.push({ t: group[i].t, text });
    }
    await wait(120);
  }

  if (!changed) throw new Error("Nenhum serviço de tradução respondeu.");
  return translated;
}

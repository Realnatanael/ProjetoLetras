const ENDPOINT = "https://api.mymemory.translated.net/get";
const MAX_CHARS = 420;

async function translateChunk(text) {
  const url = `${ENDPOINT}?${new URLSearchParams({
    q: text,
    langpair: "autodetect|pt-BR",
  })}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Tradução falhou (${response.status}).`);
  const data = await response.json();
  const translated = data?.responseData?.translatedText;
  if (!translated) throw new Error("Tradução vazia.");
  if (String(data.responseStatus) === "429" || /MYMEMORY WARNING/i.test(translated)) {
    const error = new Error("Limite diário da tradução gratuita.");
    error.code = "rate_limit";
    throw error;
  }
  return translated;
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
    const parts = result.split("\n");
    for (let i = 0; i < group.length; i += 1) {
      translated.push({
        t: group[i].t,
        text: (parts[i] || group[i].text).trim() || group[i].text,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return translated;
}

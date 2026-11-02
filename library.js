export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(?:feat|ft)\.?\b.*$/i, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function songKey(artist, title) {
  return `${normalize(artist)}|${normalize(title)}`;
}

function stampToSeconds(minutes, seconds, fraction) {
  const whole = Number(minutes) * 60 + Number(seconds);
  if (!fraction) return whole;
  return whole + Number(fraction) / 10 ** fraction.length;
}

function parseWords(raw, lineTime, offset) {
  if (!/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/.test(raw)) return null;
  const words = [];
  const token = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>|([^\s<]+)/g;
  let last = lineTime;
  let match = token.exec(raw);
  while (match) {
    if (match[1] != null) last = stampToSeconds(match[1], match[2], match[3]) + offset;
    else words.push({ t: last, text: match[4] });
    match = token.exec(raw);
  }
  return words.length ? words : null;
}

function shiftWords(words, delta) {
  if (!words?.length || !delta) return words;
  return words.map((word) => ({ ...word, t: word.t + delta }));
}

export function parseLrc(source) {
  const lines = [];
  let offset = 0;

  for (const raw of String(source || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const offsetTag = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetTag) {
      offset = Number(offsetTag[1]) / 1000;
      continue;
    }

    const stamps = [];
    const marked = raw.replace(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, (_, minutes, seconds, fraction) => {
      stamps.push(stampToSeconds(minutes, seconds, fraction));
      return "";
    });
    const text = marked.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").replace(/\s+/g, " ").trim();
    if (stamps.length === 0) continue;
    const interlude = !text || /^(?:\.{2,}|…+|♪+|♫+|·+|-+|\(\s*instrumental\s*\)|instrumental)$/i.test(text);

    const first = stamps[0] + offset;
    const words = interlude ? null : parseWords(marked, first, offset);
    for (const time of stamps) {
      const start = time + offset;
      lines.push({
        t: start,
        text: interlude ? "♪♪" : text,
        interlude,
        words: words ? shiftWords(words, start - first) : undefined,
      });
    }
  }

  lines.sort((a, b) => a.t - b.t);
  return lines;
}

export function readLrcTags(source) {
  const text = String(source || "");
  return {
    title: text.match(/^\[ti:(.*?)\]/im)?.[1]?.trim() || "",
    artist: text.match(/^\[ar:(.*?)\]/im)?.[1]?.trim() || "",
  };
}

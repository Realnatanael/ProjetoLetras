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
    const text = raw
      .replace(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, (_, minutes, seconds, fraction) => {
        stamps.push(stampToSeconds(minutes, seconds, fraction));
        return "";
      })
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "")
      .trim();

    if (!text || stamps.length === 0) continue;
    for (const time of stamps) lines.push({ t: time + offset, text });
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

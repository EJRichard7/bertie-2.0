// src/utils/highlightTargets.js

export function getSentenceRange(words, currentIdx) {
  if (!words || currentIdx == null) return null;

  let start = currentIdx;
  let end = currentIdx;

  const isSentenceEnd = (w) =>
    /[.!?]["')\]]?$/.test(w?.text || "");

  while (start > 0 && !isSentenceEnd(words[start - 1])) {
    start--;
  }

  while (end < words.length - 1 && !isSentenceEnd(words[end])) {
    end++;
  }

  return { start, end };
}

export function getParagraphRange(words, currentIdx) {
  if (!words || currentIdx == null) return null;

  const page = words[currentIdx]?.page;
  if (page == null) return null;

  const samePageIdxs = words
    .map((w, i) => (w.page === page ? i : null))
    .filter((i) => i !== null);

  if (!words[currentIdx]?.rect) {
    return getSentenceRange(words, currentIdx);
  }

  const pos = samePageIdxs.indexOf(currentIdx);
  if (pos === -1) return null;

  const GAP = 18;

  let startPos = pos;
  while (startPos > 0) {
    const a = words[samePageIdxs[startPos - 1]]?.rect;
    const b = words[samePageIdxs[startPos]]?.rect;
    if (!a || !b) break;
    if (Math.abs(b.y - a.y) > GAP) break;
    startPos--;
  }

  let endPos = pos;
  while (endPos < samePageIdxs.length - 1) {
    const a = words[samePageIdxs[endPos]]?.rect;
    const b = words[samePageIdxs[endPos + 1]]?.rect;
    if (!a || !b) break;
    if (Math.abs(b.y - a.y) > GAP) break;
    endPos++;
  }

  return {
    start: samePageIdxs[startPos],
    end: samePageIdxs[endPos],
  };
}

// -------- DATE DETECTION --------

const month =
  "(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)";

const dateRegexes = [
  new RegExp(`\\b${month}\\s+\\d{1,2}(,\\s*\\d{4})?\\b`, "i"),
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
];

export function findDateWordRange(words, currentIdx) {
  if (!words || currentIdx == null) return null;

  const sentence = getSentenceRange(words, currentIdx);
  const ranges = [];

  if (sentence) ranges.push(sentence);

  ranges.push({
    start: Math.max(0, currentIdx - 40),
    end: Math.min(words.length - 1, currentIdx + 40),
  });

  for (const r of ranges) {
    const text = words
      .slice(r.start, r.end + 1)
      .map((w) => w.text)
      .join(" ");

    for (const regex of dateRegexes) {
      const match = text.match(regex);
      if (!match) continue;

      const targetWords = match[0].split(/\s+/);
      const chunkWords = text.split(/\s+/);

      for (let i = 0; i <= chunkWords.length - targetWords.length; i++) {
        let ok = true;
        for (let j = 0; j < targetWords.length; j++) {
          if (
            chunkWords[i + j].replace(/[^\w/]/g, "") !==
            targetWords[j].replace(/[^\w/]/g, "")
          ) {
            ok = false;
            break;
          }
        }
        if (ok) {
          return {
            start: r.start + i,
            end: r.start + i + targetWords.length - 1,
          };
        }
      }
    }
  }

  return null;
}

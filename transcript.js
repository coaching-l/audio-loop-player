// The original text of an audio file, split into sentences with start and end times,
// so the sentence being heard can be highlighted. Plain functions, no page access.

const CJK = /[㐀-鿿豈-﫿぀-ヿ]/g;
const LATIN = /[A-Za-z0-9À-ɏ]/g;
// Titles and short forms that end with a period but do not end a sentence.
const ABBREVIATIONS =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|No|Fig|Inc|Ltd|Co|U\.S|a\.m|p\.m)\.$/i;

// Splits text at sentence ends: 。！？；… with no space needed (Chinese), . ! ? before a
// space (English), and at every line break. `lineEnd` keeps the original line breaks.
export function splitSentences(text) {
  const sentences = [];
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const pieces = line
      .split(
        /(?<=[。！？；!?]["”’」』）)]*|……["”’」』）)]*)(?!["”’」』）)。！？；!?…])|(?<=[.!?]["”’)\]]*)\s+(?=\S)/u,
      )
      .map((piece) => piece?.trim())
      .filter(Boolean);
    const merged = [];
    for (const piece of pieces) {
      const previous = merged[merged.length - 1];
      if (previous && ABBREVIATIONS.test(previous))
        merged[merged.length - 1] = previous + " " + piece;
      else merged.push(piece);
    }
    merged.forEach((sentence, index) =>
      sentences.push({ text: sentence, lineEnd: index === merged.length - 1 }),
    );
  }
  return sentences;
}

// Rough speaking time of a sentence: a Chinese character takes about as long as
// three to four Latin letters.
function weight(text) {
  const cjk = text.match(CJK)?.length || 0;
  const latin = text.match(LATIN)?.length || 0;
  return Math.max(1, latin + cjk * 3.3);
}

// Gives each sentence a start and end. Without pauses, time is shared out by sentence
// length. With pauses (phrases from the waveform), each sentence boundary moves to the
// pause nearest its estimate, keeping the order; boundaries far from any pause stay put.
export function alignSentences(sentences, duration, phrases = []) {
  if (!sentences.length || !(duration > 0)) return [];
  const speech = phrases.length
    ? { start: phrases[0].start, end: phrases[phrases.length - 1].end }
    : { start: 0, end: duration };
  const span = Math.max(0.001, speech.end - speech.start);
  const weights = sentences.map((s) => weight(s.text));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const targets = [];
  let cumulative = 0;
  for (let i = 0; i < sentences.length - 1; i++) {
    cumulative += weights[i];
    targets.push(speech.start + (cumulative / total) * span);
  }
  const gaps = phrases
    .slice(1)
    .map((phrase, i) => ({ end: phrases[i].end, start: phrase.start }));
  const matched = matchBoundaries(targets, gaps, span / sentences.length);
  const timed = sentences.map((sentence) => ({
    text: sentence.text,
    lineEnd: sentence.lineEnd,
    start: 0,
    end: 0,
  }));
  timed[0].start = speech.start;
  timed[timed.length - 1].end = speech.end;
  targets.forEach((target, i) => {
    const gap = matched[i];
    timed[i].end = gap ? gap.end : target;
    timed[i + 1].start = gap ? gap.start : target;
  });
  return timed.map((s) => ({
    ...s,
    start: Math.max(0, round(s.start)),
    end: Math.min(duration, round(Math.max(s.end, s.start + 0.05))),
  }));
}

// Order-keeping match of sentence boundaries to pauses, like aligning two sequences:
// a boundary may take a pause (cost: distance) or stay unmatched (cost: tolerance).
function matchBoundaries(targets, gaps, tolerance) {
  const n = targets.length;
  const m = gaps.length;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) {
    cost[i][0] = i * tolerance;
    move[i][0] = 2;
  }
  for (let j = 1; j <= m; j++) move[0][j] = 1;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const take =
        cost[i - 1][j - 1] + Math.abs(gaps[j - 1].start - targets[i - 1]);
      const skipGap = cost[i][j - 1];
      const skipBoundary = cost[i - 1][j] + tolerance;
      const best = Math.min(take, skipGap, skipBoundary);
      cost[i][j] = best;
      move[i][j] = best === take ? 0 : best === skipGap ? 1 : 2;
    }
  const matched = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j >= 0) {
    if (j === 0 || move[i][j] === 2) i--;
    else if (move[i][j] === 1) j--;
    else {
      if (Math.abs(gaps[j - 1].start - targets[i - 1]) < tolerance)
        matched[i - 1] = gaps[j - 1];
      i--;
      j--;
    }
  }
  return matched;
}

function round(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

// The sentence being heard: the last one that has started by `time`.
export function sentenceAt(sentences, time) {
  let found = -1;
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].start <= time + 0.01) found = i;
    else break;
  }
  if (found >= 0 && time > sentences[found].end + 0.5) return -1;
  return found;
}

export function isCjk(text) {
  const cjk = text.match(CJK)?.length || 0;
  const latin = text.match(LATIN)?.length || 0;
  return cjk > latin / 3;
}

// Text files from Chinese sources are often GB18030 rather than UTF-8.
export function decodeText(bytes) {
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      /* Try the next encoding. */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function validTranscript(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.text === "string" &&
    Array.isArray(value.sentences) &&
    value.sentences.every(
      (s) =>
        s &&
        typeof s.text === "string" &&
        Number.isFinite(s.start) &&
        Number.isFinite(s.end),
    )
  );
}

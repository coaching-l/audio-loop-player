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
  return finish(
    spread(sentences, speech.start, speech.end, pausesBetween(phrases)),
    duration,
  );
}

// The silences between phrases: `end` is where the earlier phrase ends, `start` where
// the next one starts.
function pausesBetween(phrases) {
  return phrases
    .slice(1)
    .map((phrase, i) => ({ end: phrases[i].end, start: phrase.start }));
}

// Shares the time from `start` to `end` among sentences by length.
function spread(sentences, start, end, gaps) {
  const span = Math.max(0.001, end - start);
  const weights = sentences.map((s) => weight(s.text));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const targets = [];
  let cumulative = 0;
  for (let i = 0; i < sentences.length - 1; i++) {
    cumulative += weights[i];
    targets.push(start + (cumulative / total) * span);
  }
  const matched = matchBoundaries(targets, gaps, span / sentences.length);
  const timed = sentences.map((sentence) => ({
    text: sentence.text,
    lineEnd: sentence.lineEnd,
    start,
    end,
  }));
  targets.forEach((target, i) => {
    const gap = matched[i];
    timed[i].end = gap ? gap.end : target;
    timed[i + 1].start = gap ? gap.start : target;
  });
  return timed;
}

function finish(timed, duration) {
  return timed.map((s) => ({
    ...s,
    start: Math.max(0, round(s.start)),
    end: Math.min(duration, round(Math.max(s.end, s.start + 0.05))),
  }));
}

// After the text is edited, sentences that did not change keep their times, including
// times fixed by hand. A changed run of sentences shares the time of the run it replaces.
export function retimeSentences(previous, sentences, duration, phrases = []) {
  const n = previous.length;
  const m = sentences.length;
  if (!n || !m || n * m > 4e6 || !(duration > 0))
    return alignSentences(sentences, duration, phrases);
  const key = (s) => s.text.replace(/\s+/g, "");
  const before = previous.map(key);
  const after = sentences.map(key);
  // Longest common run of unchanged sentences, as in a line-by-line diff.
  const common = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      common[i][j] =
        before[i] === after[j]
          ? common[i + 1][j + 1] + 1
          : Math.max(common[i + 1][j], common[i][j + 1]);
  const gaps = pausesBetween(phrases);
  const timed = [];
  const replace = (i0, i1, j0, j1) => {
    if (j0 === j1) return;
    const added = sentences.slice(j0, j1);
    if (i1 - i0 === j1 - j0) {
      added.forEach((s, k) =>
        timed.push({ ...previous[i0 + k], text: s.text, lineEnd: s.lineEnd }),
      );
      return;
    }
    const start =
      i0 < i1 ? previous[i0].start : i0 > 0 ? previous[i0 - 1].end : 0;
    const end =
      i0 < i1 ? previous[i1 - 1].end : i1 < n ? previous[i1].start : duration;
    timed.push(
      ...spread(
        added,
        start,
        Math.max(start, end),
        gaps.filter((gap) => gap.end >= start && gap.start <= end),
      ),
    );
  };
  let i = 0;
  let j = 0;
  let i0 = 0;
  let j0 = 0;
  while (i < n && j < m) {
    if (before[i] === after[j] && common[i][j] === common[i + 1][j + 1] + 1) {
      replace(i0, i, j0, j);
      timed.push({
        ...previous[i],
        text: sentences[j].text,
        lineEnd: sentences[j].lineEnd,
      });
      i0 = ++i;
      j0 = ++j;
    } else if (common[i + 1][j] >= common[i][j + 1]) i++;
    else j++;
  }
  replace(i0, n, j0, m);
  return finish(timed, duration);
}

// A pause this long ends a sentence even without punctuation, which speech recognition
// often leaves out; a sentence longer than MAX_SENTENCE seconds is cut at its longest pause.
const LONG_PAUSE = 1;
const MAX_SENTENCE = 12;

// Speech recognition times each segment (a phrase or a sentence or two). Inside a segment
// the time is shared out by length among its words (Chinese: characters, with the
// punctuation after them), counting only the time with sound in the waveform, so the
// pauses inside a segment stay between words. Sentence edges inside a segment are
// estimates, so they may move further to a pause.
export function transcriptFromSegments(segments, duration, phrases = []) {
  const words = [];
  for (const segment of segments) {
    const tokens =
      segment.text.match(
        /\s*(?:[㐀-鿿豈-﫿぀-ヿ][^\s㐀-鿿豈-﫿぀-ヿA-Za-z0-9]*|[^\s㐀-鿿豈-﫿぀-ヿ]+)/gu,
      ) || [];
    const weights = tokens.map(weight);
    const total = weights.reduce((sum, w) => sum + w, 0);
    let parts = phrases
      .map((p) => [
        Math.max(segment.start, p.start),
        Math.min(segment.end, p.end),
      ])
      .filter(([from, to]) => to - from > 0.05);
    if (!parts.length)
      parts = [[segment.start, Math.max(segment.start, segment.end)]];
    const speech = parts.reduce((sum, [from, to]) => sum + to - from, 0);
    // Each word goes to the part of sound where its share falls, so words never span a
    // pause. A space or punctuation a word or two away marks the pause better.
    const firsts = parts.map(() => tokens.length); // first word of each part
    let done = 0;
    let part = 0;
    let offset = 0;
    tokens.forEach((text, i) => {
      const length = (speech * weights[i]) / total;
      while (
        part < parts.length - 1 &&
        done + length / 2 > offset + parts[part][1] - parts[part][0]
      ) {
        offset += parts[part][1] - parts[part][0];
        part++;
      }
      firsts[part] = Math.min(firsts[part], i);
      done += length;
    });
    firsts[0] = 0;
    for (let k = parts.length - 1; k > 0; k--)
      firsts[k] = Math.min(firsts[k], firsts[k + 1] ?? tokens.length);
    const breaks = (i) =>
      /^\s/u.test(tokens[i]) || /[,，、;；:：.。!！?？…]$/u.test(tokens[i - 1]);
    for (let k = 1; k < parts.length; k++) {
      const low = firsts[k - 1] + 1;
      const high = (firsts[k + 1] ?? tokens.length) - 1;
      for (const step of [0, -1, 1, -2, 2]) {
        const i = firsts[k] + step;
        if (i >= low && i <= high && i < tokens.length && breaks(i)) {
          firsts[k] = i;
          break;
        }
      }
    }
    const groups = parts.map((_, k) =>
      tokens.map((_, i) => i).slice(firsts[k], firsts[k + 1] ?? tokens.length),
    );
    groups.forEach((group, part) => {
      const [from, to] = parts[part];
      const sum = group.reduce((s, i) => s + weights[i], 0);
      let time = from;
      for (const i of group) {
        const end = time + ((to - from) * weights[i]) / sum;
        words.push({ text: tokens[i], start: time, end });
        time = end;
      }
    });
  }
  return transcriptFromWords(words, duration, phrases, 0.6);
}

// Builds the text and its timed sentences from recognized words ({text, start, end}, the
// text with its leading space). Sentence edges move to the waveform's phrase edges within
// `snap` seconds.
export function transcriptFromWords(words, duration, phrases = [], snap = 0.3) {
  words = words.filter(
    (w) => /\S/u.test(w.text) && Number.isFinite(w.start) && w.end >= w.start,
  );
  if (!words.length || !(duration > 0)) return null;
  let text = "";
  const owner = []; // the word of each non-space character
  words.forEach((word, index) => {
    const piece = text ? word.text : word.text.trimStart();
    text += piece;
    for (const char of piece) if (/\S/u.test(char)) owner.push(index);
  });
  const pieces = [];
  let cursor = 0;
  for (const sentence of splitSentences(text)) {
    const count = nonSpace(sentence.text);
    cut(sentence.text, cursor, cursor + count, owner, words, pieces);
    pieces[pieces.length - 1].sentenceEnd = true;
    cursor += count;
  }
  // Rejoin so that splitting the text again gives the same sentences, which keeps
  // later edits in step with the times.
  const cjk = isCjk(text);
  let joined = pieces
    .map(
      (p, i) =>
        (i ? (pieces[i - 1].sentenceEnd ? (cjk ? "" : " ") : "\n") : "") +
        p.text,
    )
    .join("");
  let lines = splitSentences(joined);
  if (
    lines.length !== pieces.length ||
    lines.some((line, i) => line.text !== pieces[i].text)
  ) {
    joined = pieces.map((p) => p.text).join("\n");
    lines = splitSentences(joined);
  }
  const timed = pieces.map((piece, i) => ({
    text: piece.text,
    lineEnd: lines[i].lineEnd,
    start: words[piece.first].start,
    end: words[piece.last].end,
  }));
  const first = timed[0];
  const last = timed[timed.length - 1];
  first.start =
    nearest(
      phrases.map((p) => p.start),
      first.start,
      snap,
    ) ?? first.start;
  last.end =
    nearest(
      phrases.map((p) => p.end),
      last.end,
      snap,
    ) ?? last.end;
  // Between two sentences, take the pause in the waveform that meets the gap between
  // them: the first ends where the pause begins, the next starts where it ends.
  const gaps = pausesBetween(phrases);
  for (let i = 0; i < timed.length - 1; i++) {
    const from = timed[i].end;
    const to = timed[i + 1].start;
    let best = null;
    let bestDistance = Infinity;
    for (const gap of gaps) {
      const distance = Math.max(
        0,
        gap.end - Math.max(from, to),
        Math.min(from, to) - gap.start,
      );
      if (
        distance <= snap &&
        (distance < bestDistance ||
          (distance === bestDistance &&
            gap.start - gap.end > best.start - best.end))
      ) {
        best = gap;
        bestDistance = distance;
      }
    }
    if (best) {
      timed[i].end = best.end;
      timed[i + 1].start = best.start;
    } else timed[i].end = Math.min(from, Math.max(to, timed[i].start));
  }
  return { text: joined, sentences: finish(timed, duration) };
}

function nonSpace(text) {
  let count = 0;
  for (const char of text) if (/\S/u.test(char)) count++;
  return count;
}

function nearest(list, time, snap) {
  let best = null;
  for (const value of list)
    if (
      Math.abs(value - time) <= snap &&
      (best === null || Math.abs(value - time) < Math.abs(best - time))
    )
      best = value;
  return best;
}

// Cuts a sentence (non-space characters from..to of the whole text) at long pauses, and
// cuts one that runs too long at its longest pause, preferring a comma.
function cut(text, from, to, owner, words, pieces) {
  const first = owner[from];
  const last = owner[to - 1];
  const length = words[last].end - words[first].start;
  let best = -1;
  let bestScore = -Infinity;
  for (let k = first; k < last; k++) {
    const pause = words[k + 1].start - words[k].end;
    const comma = /[,，、;；:：]\s*$/u.test(words[k].text);
    const balanced =
      words[k].end - words[first].start >= 2 &&
      words[last].end - words[k + 1].start >= 2;
    const score = pause + (comma ? 0.3 : 0);
    if (
      (pause >= LONG_PAUSE || (length > MAX_SENTENCE && balanced)) &&
      score > bestScore
    ) {
      best = k;
      bestScore = score;
    }
  }
  const at = best < 0 ? -1 : owner.indexOf(best + 1, from);
  if (at <= from || at >= to) {
    pieces.push({ text, first, last });
    return;
  }
  let seen = 0;
  let index = 0;
  for (const char of text) {
    if (/\S/u.test(char)) {
      if (seen === at - from) break;
      seen++;
    }
    index += char.length;
  }
  cut(text.slice(0, index).trim(), from, at, owner, words, pieces);
  cut(text.slice(index).trim(), at, to, owner, words, pieces);
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

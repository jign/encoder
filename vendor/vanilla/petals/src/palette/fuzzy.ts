/** Half-open [start, end) character ranges in the matched text. */
export type MatchRanges = readonly (readonly [number, number])[];

export interface FuzzyMatch {
  score: number;
  ranges: MatchRanges;
}

const isBoundary = (ch: string | undefined) => ch === undefined || /[\s._/\\-]/.test(ch);

/**
 * Subsequence match with bonuses for consecutive letters and word starts; shorter texts win
 * ties. Spaces in the query are ignored. Returns null when the query isn't a subsequence.
 *
 * Adapted from Quick Pose's `fuzzyScore`, extended to report the matched ranges.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, ranges: [] };
  const t = text.toLowerCase();

  let score = 0;
  let ti = 0;
  let prev = -2;
  const hits: number[] = [];

  for (const ch of q) {
    const plain = t.indexOf(ch, ti);
    if (plain < 0) return null;
    // Prefer the next occurrence at a word start, unless the plain one continues a run.
    let found = -1;
    if (plain !== prev + 1) {
      for (let k = ti; k < t.length; k++) {
        if (t[k] === ch && isBoundary(t[k - 1])) {
          found = k;
          break;
        }
      }
    }
    if (found < 0) found = plain;
    const wordStart = isBoundary(t[found - 1]);
    score += 1 + (found === prev + 1 ? 3 : 0) + (wordStart ? 4 : 0) - Math.min(3, (found - ti) * 0.1);
    hits.push(found);
    prev = found;
    ti = found + 1;
  }

  const ranges: [number, number][] = [];
  for (const i of hits) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else ranges.push([i, i + 1]);
  }

  // The greedy walk can split a word the query spells out whole ("fold" → "File's … old");
  // an unbroken occurrence, best at a word start, wins over it.
  let whole = -1;
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) {
    if (whole < 0) whole = at;
    if (isBoundary(t[at - 1])) {
      whole = at;
      break;
    }
  }
  if (whole >= 0) {
    const wholeScore = 1 + (isBoundary(t[whole - 1]) ? 4 : 0) + (q.length - 1) * 4 + 1;
    if (wholeScore > score) return { score: wholeScore - t.length * 0.01, ranges: [[whole, whole + q.length]] };
  }
  return { score: score - t.length * 0.01, ranges };
}

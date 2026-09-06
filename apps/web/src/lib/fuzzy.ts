/**
 * Subsequence fuzzy matcher used by the command palette. Scores favour matches at word
 * starts and contiguous runs, and penalise gaps. Returns null when `query` is not a
 * subsequence of `text`.
 */
export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    if (ch === ' ') continue;
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    positions.push(idx);
    let s = 1;
    if (idx === prev + 1) s += 4; // contiguous
    if (idx === 0 || /[\s\-_/:.]/.test(t[idx - 1] ?? '')) s += 6; // word start
    else if (t[idx] !== text[idx]) s += 2; // camelCase hump
    s -= Math.min(idx - ti, 10) * 0.3; // gap penalty
    score += s;
    prev = idx;
    ti = idx + 1;
  }
  // shorter texts rank higher for equal matches
  score -= text.length * 0.02;
  if (t.startsWith(q)) score += 8;
  return { score, positions };
}

export function highlightSegments(text: string, positions: number[]): { text: string; hit: boolean }[] {
  const set = new Set(positions);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i]!, hit });
  }
  return out;
}

/**
 * A tiny s-expression reader/writer for Specctra DSN and SES files. Values are strings, lists are
 * arrays; quoted strings (`"a b"`) lose their quotes on read and get them back on write when they
 * need them.
 */
export type SExpr = string | SExpr[];

export function parseSExpr(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "(") {
      const list: SExpr[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      i++;
    } else if (ch === ")") {
      if (stack.length === 1) throw new SyntaxError(`unbalanced ')' at offset ${i}`);
      stack.pop();
      i++;
    } else if (ch === '"' && /^\s*\)/.test(text.slice(i + 1, i + 4))) {
      // `(string_quote ")` — the quote character itself as a bare token
      stack[stack.length - 1]!.push('"');
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      let out = "";
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < n) j++;
        out += text[j];
        j++;
      }
      if (j >= n) throw new SyntaxError(`unterminated string at offset ${i}`);
      stack[stack.length - 1]!.push(out);
      i = j + 1;
    } else if (ch === "#" && (i === 0 || text[i - 1] === "\n")) {
      // comment line
      while (i < n && text[i] !== "\n") i++;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
    } else {
      let j = i;
      while (j < n && !/[\s()"]/.test(text[j]!)) j++;
      stack[stack.length - 1]!.push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new SyntaxError("unbalanced '(': missing closing parenthesis");
  return root;
}

/** Quotes a token when it contains characters the Specctra parser would split on. */
export function quote(s: string): string {
  if (s.length === 0) return '""';
  return /[\s()"]/.test(s) || s.includes("'") || s.includes(";") ? `"${s.replace(/"/g, "'")}"` : s;
}

export function isList(x: SExpr | undefined): x is SExpr[] {
  return Array.isArray(x);
}

/** The head token of a list (`(net GND ...)` -> `net`), or undefined. */
export function head(x: SExpr | undefined): string | undefined {
  return isList(x) && typeof x[0] === "string" ? x[0] : undefined;
}

/** Direct children of `list` that are lists headed by `name`. */
export function children(list: SExpr[] | undefined, name: string): SExpr[][] {
  if (!list) return [];
  return list.filter((c): c is SExpr[] => isList(c) && c[0] === name);
}

/** The first child list headed by `name`. */
export function child(list: SExpr[] | undefined, name: string): SExpr[] | undefined {
  return children(list, name)[0];
}

/** String children of a list, skipping the head. */
export function atoms(list: SExpr[] | undefined): string[] {
  return (list ?? []).slice(1).filter((c): c is string => typeof c === "string");
}

/** Number children of a list, skipping the head and any non-numeric atom. */
export function numbers(list: SExpr[] | undefined): number[] {
  return atoms(list)
    .map(Number)
    .filter((v) => !Number.isNaN(v));
}

/** Formats a number for a DSN/SES file: integers stay integers, others keep up to 6 decimals. */
export function num(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6).replace(/\.?0+$/, "");
}

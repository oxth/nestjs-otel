const NUMBER = /(?<![\w$:.])\d+(?:\.\d+)?(?![\w$])/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$/y;
const WORD = /[\w$\u0080-\uFFFF]/;

/** Index just past the closing quote of the string opened at `start`, or `sql.length` if unterminated. */
function skipQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (backslash && c === '\\') i += 2;
    else if (c === quote) {
      if (sql[i + 1] === quote) i += 2;
      else return i + 1;
    } else i++;
  }
  return sql.length;
}

/**
 * Replaces string literals and standalone numbers with `?` (same rule as the mysql2
 * instrumentation's default `maskStatementHook`). `$1`, `:name`, `?` placeholders and
 * identifiers containing digits are left alone, as are `-- …` and `/* … *\/` comments.
 *
 * Default (MySQL) mode: `'…'` and `"…"` are strings and honour backslash escapes.
 * `doubleQuotedStrings: false` selects PostgreSQL: `"…"` is an identifier, a backslash is an
 * ordinary character except inside `E'…'`, and `$$…$$` / `$tag$…$tag$` strings are masked.
 * An unterminated literal masks the rest of the statement.
 */
export function maskSqlLiterals(sql: string, opts?: { doubleQuotedStrings?: boolean }): string {
  const pg = opts?.doubleQuotedStrings === false;
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === "'") {
      let backslash = !pg;
      if (pg && /[eE]$/.test(out) && !WORD.test(out[out.length - 2] ?? '')) {
        backslash = true;
        out = out.slice(0, -1);
      }
      out += '?';
      i = skipQuoted(sql, i, "'", backslash);
    } else if (c === '"') {
      if (pg) {
        const end = skipQuoted(sql, i, '"', false);
        out += sql.slice(i, end);
        i = end;
      } else {
        out += '?';
        i = skipQuoted(sql, i, '"', true);
      }
    } else if (pg && c === '$' && !WORD.test(sql[i - 1] ?? '') && (DOLLAR_TAG.lastIndex = i, DOLLAR_TAG.exec(sql))) {
      const tag = sql.slice(i, DOLLAR_TAG.lastIndex);
      const end = sql.indexOf(tag, i + tag.length);
      out += '?';
      i = end === -1 ? sql.length : end + tag.length;
    } else {
      NUMBER.lastIndex = i;
      if (NUMBER.test(sql)) {
        out += '?';
        i = NUMBER.lastIndex;
      } else {
        out += c;
        i++;
      }
    }
  }
  return out;
}

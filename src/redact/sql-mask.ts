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
 * identifiers containing digits are left alone, as are comments (`-- …`, block comments, and `# …` in MySQL mode).
 *
 * Default (MySQL) mode: `'…'` and `"…"` are strings and honour backslash escapes; block comments do not nest.
 * `doubleQuotedStrings: false` selects PostgreSQL: `"…"` is an identifier, a backslash is an
 * ordinary character except inside `E'…'`, and `$$…$$` / `$tag$…$tag$` strings are masked; block comments nest.
 * An unterminated literal masks the rest of the statement.
 */
export function maskSqlLiterals(sql: string, opts?: { doubleQuotedStrings?: boolean }): string {
  const pg = opts?.doubleQuotedStrings === false;
  const n = sql.length;
  let out = '';
  let copyFrom = 0;
  let i = 0;
  const mask = (flushTo: number, resume: number) => {
    out += sql.slice(copyFrom, flushTo) + '?';
    copyFrom = i = resume;
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if ((c === '-' && next === '-') || (!pg && c === '#')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else if (pg && sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else i++;
      }
    } else if (c === "'") {
      let backslash = !pg;
      let flushTo = i;
      if (pg && i - 1 >= copyFrom && (sql[i - 1] === 'e' || sql[i - 1] === 'E') && !WORD.test(sql[i - 2] ?? '')) {
        backslash = true;
        flushTo = i - 1;
      }
      mask(flushTo, skipQuoted(sql, i, "'", backslash));
    } else if (c === '"') {
      const end = skipQuoted(sql, i, '"', !pg);
      if (pg) i = end;
      else mask(i, end);
    } else if (pg && c === '$' && !WORD.test(sql[i - 1] ?? '') && ((DOLLAR_TAG.lastIndex = i), DOLLAR_TAG.exec(sql))) {
      const tag = sql.slice(i, DOLLAR_TAG.lastIndex);
      const end = sql.indexOf(tag, i + tag.length);
      mask(i, end === -1 ? n : end + tag.length);
    } else if (c >= '0' && c <= '9') {
      NUMBER.lastIndex = i;
      if (NUMBER.test(sql)) mask(i, NUMBER.lastIndex);
      else i++;
    } else {
      i++;
    }
  }
  return copyFrom === 0 ? sql : out + sql.slice(copyFrom);
}

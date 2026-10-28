/**
 * Replaces string literals and standalone numbers with `?` (same rule as the mysql2
 * instrumentation's default `maskStatementHook`). `$1`, `:name`, `?` placeholders and
 * identifiers containing digits are left alone. Set `doubleQuotedStrings: false` for
 * PostgreSQL, where `"…"` is an identifier.
 */
export function maskSqlLiterals(sql: string, opts?: { doubleQuotedStrings?: boolean }): string {
  const dq = opts?.doubleQuotedStrings ?? true;
  const re = dq
    ? /'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|(?<![\w$:.])\d+(?:\.\d+)?(?![\w$])/g
    : /'(?:[^'\\]|\\.|'')*'|"(?:[^"]|"")*"|(?<![\w$:.])\d+(?:\.\d+)?(?![\w$])/g;
  return sql.replace(re, (m) => (m[0] === '"' && !dq ? m : '?'));
}

import { describe, expect, it } from 'vitest';
import { maskSqlLiterals } from '../../src/redact/sql-mask';

describe('maskSqlLiterals', () => {
  it('masks single-quoted strings and numbers', () => {
    expect(maskSqlLiterals("SELECT * FROM u WHERE pw = 'hunter2' AND id = 42 LIMIT 10")).toBe(
      'SELECT * FROM u WHERE pw = ? AND id = ? LIMIT ?',
    );
  });
  it('handles escaped quotes', () => expect(maskSqlLiterals("x = 'it''s'")).toBe('x = ?'));
  it('keeps placeholders and identifiers with digits', () => {
    expect(
      maskSqlLiterals('SELECT "t1"."col2" FROM t1 WHERE a = $1 AND b = :name AND c = ?', { doubleQuotedStrings: false }),
    ).toBe('SELECT "t1"."col2" FROM t1 WHERE a = $1 AND b = :name AND c = ?');
  });
  it('double-quoted strings masked when enabled', () => expect(maskSqlLiterals('x = "secret"')).toBe('x = ?'));
  it('masks decimals', () => expect(maskSqlLiterals('x = 1.5')).toBe('x = ?'));
});

describe('maskSqlLiterals hardening', () => {
  const pg = { doubleQuotedStrings: false };
  it('pg: backslash is literal in plain strings', () =>
    expect(maskSqlLiterals("p = 'C:\\' AND q = 'secret'", pg)).toBe('p = ? AND q = ?'));
  it('pg: E strings honour backslash escapes', () =>
    expect(maskSqlLiterals("p = E'it\\'s' AND q = 'secret'", pg)).toBe('p = ? AND q = ?'));
  it('mysql: backslash escapes kept', () =>
    expect(maskSqlLiterals("p = 'it\\'s secret' AND q = 1")).toBe('p = ? AND q = ?'));
  it('skips -- comments so apostrophes do not desync', () =>
    expect(maskSqlLiterals("SELECT 1 -- don't\nWHERE x = 'secret'", pg)).toBe("SELECT ? -- don't\nWHERE x = ?"));
  it('skips block comments', () =>
    expect(maskSqlLiterals("SELECT /* don't */ 1 WHERE x = 'secret'")).toBe("SELECT /* don't */ ? WHERE x = ?"));
  it('pg: masks dollar-quoted strings, keeps $1', () => {
    expect(maskSqlLiterals("x = $$it's secret$$ AND y = $1", pg)).toBe('x = ? AND y = $1');
    expect(maskSqlLiterals("x = $tag$ a $$ 'b' $tag$ AND z = 5", pg)).toBe('x = ? AND z = ?');
  });
  it('unterminated quote does not throw', () => {
    expect(() => maskSqlLiterals("x = 'abc", pg)).not.toThrow();
    expect(maskSqlLiterals("x = 'abc")).toBe('x = ?');
    expect(maskSqlLiterals('x = $$abc', pg)).toBe('x = ?');
    expect(maskSqlLiterals('x = /* abc')).toBe('x = /* abc');
  });
});

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
  it('pg: nested block comments', () =>
    expect(maskSqlLiterals("/* /* nested */ don't */ x = 'secret'", pg)).toBe("/* /* nested */ don't */ x = ?"));
  it('mysql: # comments skipped', () =>
    expect(maskSqlLiterals("SELECT 1 # don't\nWHERE x = 'secret'")).toBe("SELECT ? # don't\nWHERE x = ?"));
  it('pg: # is not a comment', () => expect(maskSqlLiterals("a #> 'k' ", pg)).toBe('a #> ? '));
  it('pg: E prefix at start of input', () => expect(maskSqlLiterals("E'a\\'b'", pg)).toBe('?'));
  it('runs in linear time on 1 MB input in pg mode', () => {
    for (const unit of ["'a',", "SELECT * FROM t WHERE x = 1 AND y = 'abc' "]) {
      const input = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const start = performance.now();
      const res = maskSqlLiterals(input, pg);
      expect(performance.now() - start).toBeLessThan(500);
      expect(res).not.toContain('abc');
    }
  });
});

describe('maskSqlLiterals backtick identifiers (MySQL mode)', () => {
  it('skips a backtick identifier containing a quote', () =>
    expect(maskSqlLiterals("select `it's` from t where pw = 'hunter2'")).toBe('select `it\'s` from t where pw = ?'));
  it('honours the doubled-backtick escape', () =>
    expect(maskSqlLiterals("select `a``'b` from t where pw = 'hunter2'")).toBe("select `a``'b` from t where pw = ?"));
  it('keeps digits inside backticks', () => expect(maskSqlLiterals('select `1` from t')).toBe('select `1` from t'));
});

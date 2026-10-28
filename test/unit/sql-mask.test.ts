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

import { beforeEach, describe, expect, it } from 'vitest';
import { maskStatementInError } from '../../src/orm/error-statement';
import { createRedactor } from '../../src/redact/redactor';
import { getGlobalState } from '../../src/shared/global-state';

const r = createRedactor();

beforeEach(() => {
  getGlobalState().maskedTexts = undefined;
});

describe('maskStatementInError', () => {
  it('masks the whole statement when a value contains " - "', () => {
    const message =
      "insert into `users` (`name`, `password`) values ('John - Smith', 'hunter2') - Duplicate entry 'x' for key 'PRIMARY'";
    maskStatementInError(new Error(message), 'mysql');
    const out = r.redactString(message);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('John - Smith');
    expect(out).toContain("- Duplicate entry 'x' for key 'PRIMARY'");
  });

  it('masks an UPDATE with arithmetic', () => {
    const message = "update `t` set `a` = `a` - 1, `secret` = 'abc' where `id` = 7 - deadlock found";
    maskStatementInError(new Error(message), 'mysql');
    const out = r.redactString(message);
    expect(out).not.toContain('abc');
    expect(out).toBe('update `t` set `a` = `a` - ?, `secret` = ? where `id` = ? - deadlock found');
  });
});

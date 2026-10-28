import { registerMaskedText } from '../redact/redactor';
import { maskSqlLiterals } from '../redact/sql-mask';

const SEPARATOR = ' - ';
const STATEMENT = /^\s*(?:select|insert|update|delete|with|replace|merge|upsert|call|create|alter|drop|truncate)\b/i;

/**
 * MikroORM 6 runs SQL through knex, which prefixes a failed query's error message with the statement,
 * parameters interpolated (`insert into … values ('a@b.c', 'hunter2') - duplicate key …`). That message
 * reaches the error's stack and every span and log that records it, so the statement is registered to be
 * masked (literals → `?`) wherever telemetry text is redacted. The error itself is left unchanged.
 */
export function maskStatementInError(err: unknown, system: string | undefined): void {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return;
  // The last separator: values (`'John - Smith'`) and arithmetic (`a - 1`) may contain it too. A driver
  // message containing it only means a little of that message is masked as well.
  const cut = message.lastIndexOf(SEPARATOR);
  if (cut <= 0) return;
  const statement = message.slice(0, cut);
  if (!STATEMENT.test(statement)) return;
  // `"…"` is an identifier in PostgreSQL and SQLite, a string in MySQL / MariaDB.
  const doubleQuotedStrings = system === 'mysql' || system === 'mariadb' || system === undefined;
  registerMaskedText(statement, maskSqlLiterals(statement, { doubleQuotedStrings }));
}

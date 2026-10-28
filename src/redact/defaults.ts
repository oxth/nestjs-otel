/** Normalized (lowercase, no `-`/`_`) fragments; a key matches if it contains one. */
export const DEFAULT_SUBSTRING_KEYS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'apikey',
  'cookie',
  'session',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
  'privatekey',
];

/** Normalized keys that only match exactly (a substring match would hit e.g. `author`). */
export const DEFAULT_EXACT_KEYS: readonly string[] = ['auth'];

/** Lowercase header names always redacted. */
export const DEFAULT_HEADER_KEYS: readonly string[] = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

/** Bearer runs first so `Bearer <jwt>` is masked as a whole. */
export const DEFAULT_VALUE_PATTERNS: readonly RegExp[] = [/Bearer\s+[\w\-.~+/]+=*/gi, /eyJ[\w-]+\.[\w-]+\.[\w-]+/g];

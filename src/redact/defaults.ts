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

/** `@opentelemetry/instrumentation-http`'s own default list (not exported by it); kept when we pass ours. */
const HTTP_INSTRUMENTATION_QUERY_PARAMS: readonly string[] = [
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
];

/**
 * Query parameter names whose values instrumentation-http redacts in `url.query` / `url.full`.
 * It matches names exactly and case-sensitively, so this lists concrete spellings.
 */
export const DEFAULT_QUERY_PARAMS: readonly string[] = [
  ...HTTP_INSTRUMENTATION_QUERY_PARAMS,
  ...DEFAULT_SUBSTRING_KEYS,
  ...DEFAULT_EXACT_KEYS,
  'access_token',
  'refresh_token',
  'id_token',
  'auth_token',
  'api_key',
  'api-key',
  'x-api-key',
  'client_secret',
  'private_key',
  'session_id',
  'sessionid',
  'jwt',
  'code',
  'signature',
];

import { CENSOR } from '../shared/constants';
import {
  DEFAULT_EXACT_KEYS,
  DEFAULT_HEADER_KEYS,
  DEFAULT_SUBSTRING_KEYS,
  DEFAULT_VALUE_PATTERNS,
} from './defaults';

export interface RedactOptions {
  keys?: string[];
  replaceDefaultKeys?: boolean;
  patterns?: RegExp[];
  replaceDefaultPatterns?: boolean;
  censor?: string;
  custom?: (value: unknown, path: readonly string[]) => unknown;
}

export interface Redactor {
  redact(value: unknown): unknown;
  redactString(value: string): string;
  isSensitiveKey(key: string): boolean;
  redactHeaders(h: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined>;
}

const MAX_DEPTH = 20;
const MAX_ARRAY = 1000;
const UNSERIALIZABLE = '[Unserializable]';
const DROP = Symbol('drop');

const normalizeKey = (k: string): string => k.toLowerCase().replace(/[-_]/g, '');

const globalize = (p: RegExp): RegExp => new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');

export function createRedactor(opts: RedactOptions = {}): Redactor {
  const censor = opts.censor ?? CENSOR;
  const custom = opts.custom;
  const substrings = [
    ...(opts.replaceDefaultKeys ? [] : DEFAULT_SUBSTRING_KEYS),
    ...(opts.keys ?? []).map(normalizeKey),
  ].filter(Boolean);
  const exact = new Set(opts.replaceDefaultKeys ? [] : DEFAULT_EXACT_KEYS);
  const headerKeys = new Set(opts.replaceDefaultKeys ? [] : DEFAULT_HEADER_KEYS);
  const patterns = [...(opts.replaceDefaultPatterns ? [] : DEFAULT_VALUE_PATTERNS), ...(opts.patterns ?? [])].map(
    globalize,
  );

  const isSensitiveKey = (key: string): boolean => {
    const n = normalizeKey(key);
    return exact.has(n) || substrings.some((s) => n.includes(s));
  };

  const redactString = (value: string): string => {
    let out = value;
    for (const p of patterns) {
      p.lastIndex = 0;
      out = out.replace(p, censor);
      p.lastIndex = 0;
    }
    return out;
  };

  const applyCustom = (value: unknown, path: string[]): unknown => {
    if (!custom) return value;
    try {
      return custom(value, path);
    } catch {
      return UNSERIALIZABLE;
    }
  };

  const walk = (value: unknown, path: string[], depth: number, seen: WeakSet<object>): unknown => {
    switch (typeof value) {
      case 'string':
        return applyCustom(redactString(value), path);
      case 'bigint':
        return applyCustom(value.toString(), path);
      case 'function':
      case 'symbol':
        return DROP;
      case 'undefined':
        return undefined;
      case 'object':
        break;
      default:
        return applyCustom(value, path);
    }
    if (value === null) return applyCustom(value, path);
    if (depth > MAX_DEPTH) return '[Truncated]';
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      return applyCustom(`[Buffer ${value.byteLength} bytes]`, path);
    }
    if (value instanceof Date) {
      return applyCustom(Number.isNaN(value.getTime()) ? UNSERIALIZABLE : value.toISOString(), path);
    }
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        const converted = toJSON.call(value);
        if (converted !== value) return walk(converted, path, depth, seen);
      }
      if (Array.isArray(value)) {
        const out: unknown[] = [];
        const n = Math.min(value.length, MAX_ARRAY);
        for (let i = 0; i < n; i++) {
          const v = walk(value[i], [...path, String(i)], depth + 1, seen);
          out.push(v === DROP ? null : v);
        }
        if (value.length > MAX_ARRAY) out.push(`[… ${value.length - MAX_ARRAY} more]`);
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        let v: unknown;
        if (isSensitiveKey(key)) {
          v = censor;
        } else {
          try {
            v = walk((value as Record<string, unknown>)[key], [...path, key], depth + 1, seen);
          } catch {
            v = UNSERIALIZABLE;
          }
        }
        if (v === DROP) continue;
        if (key === '__proto__') Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
        else out[key] = v;
      }
      return out;
    } catch {
      return UNSERIALIZABLE;
    } finally {
      seen.delete(value);
    }
  };

  const redact = (value: unknown): unknown => {
    try {
      const v = walk(value, [], 0, new WeakSet());
      return v === DROP ? undefined : v;
    } catch {
      return UNSERIALIZABLE;
    }
  };

  const redactHeaders: Redactor['redactHeaders'] = (h) => {
    const out: Record<string, string | string[] | undefined> = {};
    try {
      for (const [name, val] of Object.entries(h ?? {})) {
        if (headerKeys.has(name.toLowerCase()) || isSensitiveKey(name)) out[name] = censor;
        else if (typeof val === 'string') out[name] = redactString(val);
        else if (Array.isArray(val)) out[name] = val.map((x) => (typeof x === 'string' ? redactString(x) : x));
        else out[name] = val;
      }
    } catch {
      // never throw into app code
    }
    return out;
  };

  return { redact, redactString, isSensitiveKey, redactHeaders };
}

let defaultRedactor: Redactor | undefined;

/**
 * Redactor for places without module options (error events, `OtelLogger`, process errors):
 * the default key and pattern set until `OtelModule` installs the one built from its options.
 */
export function getDefaultRedactor(): Redactor {
  return (defaultRedactor ??= createRedactor());
}

export function setDefaultRedactor(r: Redactor): void {
  defaultRedactor = r;
}

export function serializeBody(value: unknown, maxBytes: number): { body: string; truncated: boolean } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = JSON.stringify(UNSERIALIZABLE);
  }
  if (json === undefined) return { body: '', truncated: false };
  const buf = Buffer.from(json, 'utf8');
  if (buf.length <= maxBytes) return { body: json, truncated: false };
  let end = Math.max(0, maxBytes);
  // Back off while the first excluded byte is a UTF-8 continuation byte (mid code point).
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { body: buf.subarray(0, end).toString('utf8'), truncated: true };
}

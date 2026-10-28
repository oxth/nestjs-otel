/**
 * Copies everything Nest (and other libraries) may have attached to a method
 * function onto its replacement: own reflect-metadata entries, own enumerable
 * properties, and the `name` / `length` of the original.
 */
export function copyMethodMetadata(from: Function, to: Function): void {
  const reflect = Reflect as typeof Reflect & {
    getOwnMetadataKeys?: (target: object) => unknown[];
    getOwnMetadata?: (key: unknown, target: object) => unknown;
    defineMetadata?: (key: unknown, value: unknown, target: object) => void;
  };
  if (reflect.getOwnMetadataKeys && reflect.getOwnMetadata && reflect.defineMetadata) {
    for (const key of reflect.getOwnMetadataKeys(from)) {
      reflect.defineMetadata(key, reflect.getOwnMetadata(key, from), to);
    }
  }
  for (const key of Reflect.ownKeys(from)) {
    const desc = Object.getOwnPropertyDescriptor(from, key);
    if (desc?.enumerable) Object.defineProperty(to, key, desc);
  }
  Object.defineProperty(to, 'name', { value: from.name, configurable: true });
  Object.defineProperty(to, 'length', { value: from.length, configurable: true });
}

import { describe, expect, it } from 'vitest';
import { patchMethods, unpatchMethods } from '../../src/orm/patch';

const wrap = (original: (...a: any[]) => any) =>
  function (this: unknown, ...a: unknown[]) {
    return `wrapped:${original.apply(this, a)}`;
  };

describe('patchMethods / unpatchMethods on a subclass', () => {
  const classes = () => {
    class Base {
      find() {
        return 'base';
      }
      save() {
        return 'save';
      }
    }
    class Sub extends Base {
      override find() {
        return 'sub';
      }
    }
    return { Base, Sub };
  };

  it('ownOnly patches only own overrides and never shadows inherited methods', () => {
    const { Sub } = classes();
    expect(patchMethods(Sub.prototype, ['find', 'save'], wrap, { ownOnly: true })).toEqual(['find']);
    expect(Object.hasOwn(Sub.prototype, 'save')).toBe(false);
    expect(new Sub().find()).toBe('wrapped:sub');
    unpatchMethods(Sub.prototype, ['find', 'save']);
    expect(new Sub().find()).toBe('sub');
  });

  it('unpatching a subclass leaves an inherited patched method alone', () => {
    const { Base, Sub } = classes();
    patchMethods(Base.prototype, ['save'], wrap);
    try {
      unpatchMethods(Sub.prototype, ['save']);
      expect(Object.hasOwn(Sub.prototype, 'save')).toBe(false);
      expect(new Sub().save()).toBe('wrapped:save');
    } finally {
      unpatchMethods(Base.prototype, ['save']);
    }
    expect(new Sub().save()).toBe('save');
  });
});

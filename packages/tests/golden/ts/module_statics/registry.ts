// The declaring module: statics of every kind, on a plain class, a subclass and a view class.

export class Registry {
  static count = 0;
  static label = 'reg';
  static #secret = 4;

  static next(): number {
    Registry.count += 1;
    return Registry.count;
  }

  static get secret(): number {
    return Registry.#secret;
  }

  static set secret(value: number) {
    Registry.#secret = value * 2;
  }
}

export class Named extends Registry {
  static describe(): string {
    return `${Named.label}:${Named.count}`;
  }
}

export class Bytes extends Uint8Array {
  static of2(a: number, b: number): Bytes {
    const out = new Bytes(2);
    out[0] = a;
    out[1] = b;
    return out;
  }
}

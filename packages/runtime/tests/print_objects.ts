/* Ground truth for print_objects.c. Builds the SAME objects in the SAME order and prints them with
 * console.log; `just runtime-test` diffs the two byte-for-byte. Keep the order in sync.
 *
 * The classes here declare their fields in the constructor in slot order, because that is what the
 * C side's JSRTClass field list means: slot 0 is the first field, and Node prints own properties in
 * insertion order. A field left unassigned must still be assigned `undefined` here — the C side
 * always has the slot, so Node has to have the key. */

class Empty {}

class P {
  x: unknown;
  y: unknown;
  constructor(x: unknown, y: unknown) {
    this.x = x;
    this.y = y;
  }
}

class Deep {
  v: unknown;
  constructor(v: unknown) {
    this.v = v;
  }
}

class S {
  v: unknown;
  constructor(v: unknown) {
    this.v = v;
  }
}

class AVeryLongClassNameIndeed {
  v: unknown;
  constructor(v: unknown) {
    this.v = v;
  }
}

class Wide {
  [key: string]: number;
  constructor() {
    for (let i = 0; i < 8; i++) {
      this[`field${i}`] = i;
    }
  }
}

class Long {
  averyveryverylongfieldname: unknown;
  another: unknown;
  constructor(a: unknown, b: unknown) {
    this.averyveryverylongfieldname = a;
    this.another = b;
  }
}

class N {
  arr: unknown;
  o: unknown;
  constructor(arr: unknown, o: unknown) {
    this.arr = arr;
    this.o = o;
  }
}

console.log(new Empty());
console.log(new P(1, 2));

console.log(new P('a', "it's"));

console.log(new P(true, null));
console.log(new P(undefined, -0));
console.log(new P(NaN, Infinity));

console.log([new P(1, 2)]);
console.log(new N([1, 2, 3], new P(1, 2)));
console.log([[new P(1, 2)]]);

console.log(new Deep(new Deep(new Deep(new Deep(1)))));

console.log(new Wide());

console.log(new Long('a string value here', 'and another long one'));

const payload = '0123456789012345678901234567890123456789012345678901234567';
console.log(new S(payload));
console.log(new AVeryLongClassNameIndeed(payload));

class Priv {
  #hidden: unknown;
  shown: unknown;
  constructor(hidden: unknown, shown: unknown) {
    this.#hidden = hidden;
    this.shown = shown;
    void this.#hidden;
  }
}

class AllPriv {
  #a: unknown;
  #b: unknown;
  constructor(a: unknown, b: unknown) {
    this.#a = a;
    this.#b = b;
    void this.#a;
    void this.#b;
  }
}

console.log(new P(undefined, undefined));

console.log(new Priv(1, 2));
console.log(new AllPriv(1, 2));

console.log(String(new P(1, 2)));
console.log(String([new P(1, 2), 3]));

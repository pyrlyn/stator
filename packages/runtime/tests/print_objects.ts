/* Ground truth for print_objects.c. Builds the SAME objects in the SAME order and prints them with
 * console.log; `just runtime-test` diffs the two byte-for-byte. Keep the order in sync.
 *
 * The classes here declare their fields in the constructor in slot order, because that is what the
 * C side's JSRTClass field list means: slot 0 is the first field, and Node prints own properties in
 * insertion order. A field left unassigned must still be assigned `undefined` here — the C side
 * always has the slot, so Node has to have the key. */

class Empty {}

class P {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

class Deep {
  constructor(v) {
    this.v = v;
  }
}

class S {
  constructor(v) {
    this.v = v;
  }
}

class AVeryLongClassNameIndeed {
  constructor(v) {
    this.v = v;
  }
}

class Wide {
  constructor() {
    for (let i = 0; i < 8; i++) {
      this[`field${i}`] = i;
    }
  }
}

class Long {
  constructor(a, b) {
    this.averyveryverylongfieldname = a;
    this.another = b;
  }
}

class N {
  constructor(arr, o) {
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
  #hidden;
  constructor(hidden, shown) {
    this.#hidden = hidden;
    this.shown = shown;
  }
}

class AllPriv {
  #a;
  #b;
  constructor(a, b) {
    this.#a = a;
    this.#b = b;
  }
}

console.log(new P(undefined, undefined));

console.log(new Priv(1, 2));
console.log(new AllPriv(1, 2));

console.log(String(new P(1, 2)));
console.log(String([new P(1, 2), 3]));

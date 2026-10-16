// plan-notes 319: whether a call passes a receiver is said by the call, never guessed from its
// argument count. Each line here once bound `this` to the first argument, or the first argument
// to the receiver's slot, because the count happened to equal the method's arity.

class Pair {
  readonly tag: string;
  constructor(tag: string, note?: string) {
    this.tag = tag;
    console.log("ctor", tag, note);
  }
  join(a: string, b?: string): string {
    return `${this.tag}:${a}:${b}`;
  }
  count(a: number, b: number = 10, c?: number): string {
    return `${this.tag} ${a} ${b} ${c}`;
  }
  get label(): string {
    return `<${this.tag}>`;
  }
  static make(tag: string, note?: string): string {
    return `make ${tag} ${note}`;
  }
}

class Named extends Pair {
  constructor() {
    super("named");
  }
  override join(a: string, b?: string): string {
    return `named ${a} ${b}`;
  }
}

const p = new Pair("p");
console.log(p.join("x"));
console.log(p.join("x", "y"));
console.log(p.count(1), p.count(1, 2), p.count(1, 2, 3));
console.log(p.label);
console.log(Pair.make("m"));

// Virtual dispatch: the base's slot, the override's body, the optional argument omitted.
const base: Pair = new Named();
console.log(base.join("v"));

// A method value takes no receiver however many arguments it gets: `map` passes three to a
// two-parameter method, and a bare call passes as many as the method declares.
class Echo {
  show(a: number, b?: number): string {
    return `${typeof this} ${a} ${b}`;
  }
}
const show = new Echo().show;
console.log([7, 8].map(show).join(" | "));
console.log(show(1, 2));

// A class field holding an arrow is called through the field, with no receiver to declare.
class Holder {
  readonly run = (a: string, b?: string): string => `run ${a} ${b}`;
}
console.log(new Holder().run("r"));

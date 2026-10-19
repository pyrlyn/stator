// print_typeof.ts — the ground truth for print_typeof.c. Same values, same order, console.log.
// If these two files drift apart the diff is meaningless, so edit them together.

class P {
  x: unknown;
  constructor(x: unknown) {
    this.x = x;
  }
}

const show = (v: unknown): void => console.log(typeof v);

show(0);
show(-0);
show(1.5);
show(0 / 0);
show(1 / 0);
show(7);
show('');
show('abc');
show(true);
show(false);
show(undefined);
show(null);

show(new P(undefined));
show([]);
show(new Map());
show(new Set());
show((x: unknown) => x);

show(typeof 1);
show(typeof null);

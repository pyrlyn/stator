// print_promise.ts — the ground truth for print_promise.c. Same promises, same subscriptions, same
// order. If these two files drift apart the diff is meaningless, so edit them together.
//
// `.then` is how JavaScript spells "subscribe a reaction", which is what the C side does natively;
// the point of the pair is that the two tick identically, not that they are written alike. The
// `setImmediate` barriers are the one place they differ by necessity: the C side drains its queue
// on demand, and a macrotask is how a Node script says "after every microtask queued so far".

function unset(): never {
  throw new Error('unset');
}

const drain = (): Promise<void> => new Promise((r: () => void) => setImmediate(r));

const note = (tag: string): [(v: unknown) => void, (e: unknown) => void] => [
  (v) => console.log(tag, 'fulfilled', v),
  (e) => console.log(tag, 'rejected', e),
];

// ------------------------------------------------------------------ print forms
console.log(new Promise(() => {}));
console.log(Promise.resolve(42));
console.log(Promise.resolve('hi'));
const boom = Promise.reject('boom');
console.log(boom);
boom.catch(() => {}); // both sides refuse an unhandled rejection: Node exits 1, the C side aborts
console.log(Promise.resolve(Promise.resolve(7)));
console.log(typeof new Promise(() => {}));

{
  const a = Promise.resolve(1);
  a.then(...note('a1'));
  a.then(...note('a2'));
}

{
  let settle: (value: number | PromiseLike<number>) => void = unset;
  const b = new Promise<number>((resolve) => {
    settle = resolve;
  });
  b.then(...note('b'));
  settle(2);
}

{
  let fail: (reason: unknown) => void = unset;
  const c = new Promise<number>((_resolve, reject) => {
    fail = reject;
  });
  c.then(...note('c'));
  fail(3);
}

{
  const d = Promise.resolve(4);
  d.then((v: number) => {
    console.log('d relay', v);
    Promise.resolve(v).then(...note('d'));
  });
}

console.log('sync done');
await drain();
console.log('drained');

{
  let settle: (value: number | PromiseLike<number>) => void = unset;
  const e = new Promise<number>((resolve) => {
    settle = resolve;
  });
  settle(5);
  settle(6);
  console.log(e);
}

{
  let settleInner: (value: number | PromiseLike<number>) => void = unset;
  let settleOuter: (value: Promise<number> | PromiseLike<Promise<number>>) => void = unset;
  const inner = new Promise<number>((resolve) => {
    settleInner = resolve;
  });
  const outer = new Promise<Promise<number>>((resolve) => {
    settleOuter = resolve;
  });
  settleOuter(inner);
  console.log(outer);
  settleInner(8);
  await drain();
  console.log(outer);
}

{
  let settleSlow: (value: number | PromiseLike<number>) => void = unset;
  const slow = new Promise<number>((resolve) => {
    settleSlow = resolve;
  });
  const all = Promise.all([slow, Promise.resolve(20), 30]);
  all.then(...note('all'));
  console.log(all);
  settleSlow(10);
  await drain();
  console.log(all);
}

{
  const all = Promise.all([]);
  all.then(...note('empty'));
  await drain();
}

{
  let failBad: (reason: unknown) => void = unset;
  let failWorse: (reason: unknown) => void = unset;
  const bad = new Promise<number>((_resolve, reject) => {
    failBad = reject;
  });
  const worse = new Promise<number>((_resolve, reject) => {
    failWorse = reject;
  });
  const all = Promise.all([bad, worse]);
  all.then(...note('rejected-all'));
  failBad(1);
  failWorse(2);
  await drain();
  console.log(all);
}

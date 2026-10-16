// Map, Set, WeakMap and WeakSet built from one iterable argument in js mode (plan.md §11c T11.4
// step 6, docs/VALUE.md §4.25): arrays, strings, Maps, iterators, generators, nullish, and V8's
// TypeErrors for a non-entry and a primitive weak key, with the iterator closed on the way out.
// A non-iterable's message names the source text in V8, so only its class is printed.
const m = new Map([['a', 1], ['b', 2], ['a', 3]]);
console.log(m, m.size, m.get('a'));
const copy = new Map(m);
copy.set('c', 4);
console.log(copy, m.size);
const s = new Set([3, 1, 3, 'x', 1]);
console.log(s, s.size, s.has('x'));
console.log(new Set('hello'));
console.log(new Set(m.keys()), new Set(m.values()));
console.log(new Map(Object.entries({ x: 1, y: [2] })));
function* gen() { yield ['g', 1]; yield ['h', 2]; }
console.log(new Map(gen()));
console.log(new Set(null), new Map(undefined));
const arr = [1, 2];
console.log(new Set(arr.map((v) => v * 2)));
const wm = new WeakMap([[m, 'm'], [s, 's']]);
console.log(wm.get(m), wm.has(s));
const ws = new WeakSet([m]);
console.log(ws.has(m), ws.has(s));
try { new Map([1]); } catch (e) { console.log(e.name, e.message); }
try { new Map(['ab']); } catch (e) { console.log(e.name, e.message); }
try { new Map(5); } catch (e) { console.log(e.name); }
try { new WeakMap([[1, 2]]); } catch (e) { console.log(e.name, e.message); }
try { new WeakSet([1]); } catch (e) { console.log(e.name, e.message); }
let closed = false;
function* bad() { try { yield ['k', 1]; yield 7; } finally { closed = true; } }
try { new Map(bad()); } catch (e) { console.log(e.message, closed); }
console.log(new Map([[{ k: 1 }, 'obj'], [[1], 'arr']]).size);

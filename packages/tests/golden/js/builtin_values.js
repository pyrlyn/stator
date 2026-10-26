// docs/VALUE.md §4.27: builtin constructors and prototypes as first-class values, .constructor,
// call/apply, hasOwnProperty, ArrayBuffer.isView, Map/Set/Date members on untyped receivers.
function c(o) { return o.constructor; }
const vals = [{}, [], new Map(), new Set(), new Date(0), /x/, new Uint8Array(2), new ArrayBuffer(2)];
const ctors = [Object, Array, Map, Set, Date, RegExp, Uint8Array, ArrayBuffer];
for (let i = 0; i < vals.length; i++) console.log(i, c(vals[i]) === ctors[i], c(vals[i]) === Object);
var has = Object.prototype.hasOwnProperty;
console.log(has.call({ a: 1 }, 'a'), has.call({ a: 1 }, 'b'), Object.prototype.toString.call([]));
console.log([0, 1, '', 'x', null].filter(Boolean).length, ['1', '2'].map(Number)[1] + 1);
function isProto(o) { return o === Object.prototype || o === Array.prototype; }
console.log(isProto({}), isProto(Object.prototype));
console.log(ArrayBuffer.isView(new Uint8Array(1)), ArrayBuffer.isView([]));
function k(m) { let n = 0; for (const x of m.keys()) n++; return n + m.size + (m.has(1) ? 100 : 0); }
const mm = new Map(); mm.set(1, 2); console.log(k(mm));
function dt(d) { return d.getTime(); } console.log(dt(new Date(5)));
function show2(o) { const k = c(o); console.log(typeof k, k === undefined ? 'undef' : k.name); }
show2({}); show2([]); show2(new Map()); show2(new Set()); show2(new Date(0)); show2(/x/); show2(new Uint8Array(2)); show2(new ArrayBuffer(2));
console.log(Number.isFinite(1), Number.isFinite("1"), Number.isFinite(Infinity), Number.isNaN(NaN), Number.isNaN("x"));

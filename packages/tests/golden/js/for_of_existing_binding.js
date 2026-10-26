// for-of over an existing binding assigns it; a destructuring-free target stays the same variable.
let x;
for (x of [1, 2, 3]) console.log(x * 2);
console.log('last', x);
function find(iter, tar) {
  var key;
  for (key of iter.keys()) { if (key === tar) return key; }
}
console.log(find((() => { const m = new Map(); m.set('a', 1); m.set('b', 2); return m; })(), 'b'));
const s = new Set(); s.add(4); s.add(5);
var v;
for (v of s) console.log(v);

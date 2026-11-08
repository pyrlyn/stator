// Strings and builtins the scripts lean on.
const s = 'Stator engine';
console.log(
  s.length,
  s.toUpperCase(),
  s.slice(1, 4),
  s.indexOf('e'),
  s.split(' ').reverse().join(' '),
);
let acc = '';
for (let i = 0; i < 10; i++) acc += String.fromCharCode(97 + i);
console.log(acc, acc.charCodeAt(3), `${acc.length * 2}px`);
console.log(JSON.stringify({ s, n: [1, 2.5, -0], t: true, z: null }));
console.log(JSON.parse('{"a":[1,2,{"b":"c"}]}').a[2].b);
console.log(
  [3, 1, 2].sort().join(),
  [1, 2, 3].reduce((x, y) => x + y, 0),
);
console.log(
  parseInt('42px'),
  parseFloat('3.5e2'),
  Number('0x10'),
  (255).toString(16),
  (1.005).toFixed(2),
);

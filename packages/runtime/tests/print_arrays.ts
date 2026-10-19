/* print_arrays.ts — the ground truth for runtime/tests/print_arrays.c.
 *
 * Same arrays, same order, console.log. `just runtime-test` diffs this against the C program's
 * stdout byte-for-byte. Edit both files together or the diff is meaningless.
 */

const repeated = <T>(n: number, fill: T): T[] => Array.from({ length: n }, () => fill);
const counted = (n: number): number[] => Array.from({ length: n }, (_, i: number) => i);

console.log([]);
console.log([1]);
console.log([1, 2, 3]);

console.log(counted(6));
console.log(counted(7));
console.log(counted(10));
console.log(counted(27));

console.log([1, 2, 3, 4, 5, 6, 'a string long enough to dominate every column in the block']);

console.log(['a', 'bb', 'ccc', 'dddd', 'e', 'ffff', 'g', 'hh']);

console.log([true, false, null, undefined]);
console.log([-0, Number.NaN, Number.POSITIVE_INFINITY, 1e21, 1e-7]);

console.log(['plain', "has'single", 'has"double']);
console.log([`has'both"quotes`, 'back\\slash']);
console.log(['tab\there', 'nl\nhere', '\x01ctl']);
console.log(['éaccent', '✓check']);

console.log([
  [1, 2],
  [3, 4],
]);
console.log([[[1]]]);
console.log([[[[1]]]]);
console.log([[]]);

console.log(['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc', 'dddddddddddddddddddd']);
console.log(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
console.log(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);

console.log([
  1,
  ['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc', 'dddddddddddddddddddd'],
]);

console.log(repeated(100, 0));
console.log(repeated(101, 0));
console.log(repeated(102, 0));

console.log('' + [1, 2, 3]);
console.log('' + [1, [2, 3]]);
console.log('' + [1, null, undefined, 2]);
console.log('' + []);

{
  const array = [10, 20, 30];
  console.log(array[0]);
  console.log(array[2]);
  console.log(array[3]);
  console.log(array[-1]);
  console.log(array[1.5]);
  console.log(array[Number.NaN]);
  console.log(array.length);

  array[1] = 99;
  console.log(array);
  array[3] = 40;
  console.log(array);
  console.log(array.length);
}

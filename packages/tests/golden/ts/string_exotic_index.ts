function first(a: string): string | undefined {
  return a[0];
}
function at(a: string, i: number): string | undefined {
  return a[i];
}
const s = 'ab';
console.log(first(s));
console.log(at(s, 1));
console.log(at(s, 2));
console.log(at(s, 0));

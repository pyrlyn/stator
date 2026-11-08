// An uncaught exception: stdout stops, the process exits 1.
console.log('before');
function fail(): never {
  throw new TypeError('bad');
}
fail();
console.log('after');

// RegExp.prototype.test ToStrings a non-string subject; Object.keys on an untyped value.
function t(re, v) { return re.test(v); }
console.log(t(/^\d+$/, 42), t(/^a/, null), t(/true/, true));
function n(o) { return Object.keys(o).length; }
console.log(n({ a: 1, b: 2 }), n([1, 2, 3]), n(5));

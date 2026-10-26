// A var a nested function owns is distinct from the enclosing function's var of the same name.
function outer(xs) {
  function inner(ks) {
    var s = 0;
    for (var i = 0; i < ks.length - 1; i++) { s += ks[i]; }
    return s;
  }
  var t = 0;
  for (var i = 0; i < xs.length; i++) { t += inner(xs); }
  return t;
}
console.log(outer([1, 2, 3]));
function outer2(xs) {
  function inner(k) {
    var value = k * 2;
    [1].forEach(function () { value += 1; });
    return value;
  }
  var value = 0;
  for (var i = 0; i < xs.length; i++) { value += inner(xs[i]); }
  return value;
}
console.log(outer2([1, 2, 3]));

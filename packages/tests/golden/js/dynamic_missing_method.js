// A call of a name the receiver does not have throws Node's catchable TypeError
// (`x.m is not a function`) instead of aborting STA2006 (plan-notes 372). The shape table
// and the prototype walk both miss, and the dyn-method-call's `notFunction` check throws.

function callMissing(a) {
  try {
    return a.nosuch();
  } catch (e) {
    return e.name + ": " + e.message;
  }
}
console.log(callMissing([1, 2]));
console.log(callMissing("hi"));
console.log(callMissing(42));
console.log(callMissing(true));
console.log(callMissing({ x: 1 }));

// An own non-function property named like a method throws the same way.
function callNonFunction(o) {
  try {
    return o.m();
  } catch (e) {
    return e.name + ": " + e.message;
  }
}
console.log(callNonFunction({ m: 5 }));

// A real method still runs: the notFunction check is a no-op on a closure.
function callPresent(a) {
  try {
    return a.push(1) === 1 && a.length === 1;
  } catch (e) {
    return e.name + ": " + e.message;
  }
}
console.log(callPresent([]));

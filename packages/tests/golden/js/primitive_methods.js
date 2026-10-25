// String.prototype and Number.prototype on receivers the compiler only knows as Unknown
// (plan-notes 310). Each call is a dynamic method call; `jsrt_get_prop` answers the method bound
// to the primitive.

// `this` in an object literal's `function` is dynamic, so `this.name` is too.
const person = {
  name: "ada",
  shout: function () {
    return this.name.toUpperCase() + "!";
  },
  initial: function () {
    return this.name.charAt(0);
  },
};
console.log(person.shout(), person.initial());

function strings(text) {
  console.log(text.slice(1), text.slice(-2), text.substring(1, 3));
  console.log(text.indexOf("l"), text.lastIndexOf("l"), text.includes("ll"));
  console.log(text.startsWith("he"), text.endsWith("lo"), text.at(-1), text.charCodeAt(1));
  console.log(text.padStart(8, "*"), text.padEnd(8, "-"), text.repeat(2));
  console.log(text.replace("l", "L"), text.replaceAll("l", "L"), text.split("l"));
  console.log(text.concat(), text.concat(1, true, null), "  x ".trim() + "|");
  console.log(text.toUpperCase().toLowerCase(), text.trimStart(), text.trimEnd());
  console.log(text.codePointAt(0), text.codePointAt(9));
  console.log(text.match(/l+/)[0], text.search(/o/), text.toString(), text.valueOf());
}
strings("hello");

function numbers(n) {
  return [n.toString(), n.toString(2), n.toString(16), n.toFixed(), n.toFixed(3)].join(" ");
}
console.log(numbers(255.5));
console.log(numbers(-0.125));

// A method read as a value is a function with the method's name and length.
function method(value, key) {
  const m = value[key];
  return typeof m + " " + m.name + " " + m.length;
}
console.log(method("s", "padStart"), method("s", "trim"), method(1, "toFixed"));

// A name the prototype does not have still reads undefined.
function missing(value) {
  return value.notAMethod === undefined;
}
console.log(missing("s"), missing(4));

// The throwing ops throw catchable RangeErrors with Node's message.
function bad(text, n) {
  try {
    return text.repeat(n);
  } catch (e) {
    return e instanceof RangeError ? "RangeError: " + e.message : "other";
  }
}
console.log(bad("ab", -1), bad("ab", 2));
function badRadix(n) {
  try {
    return n.toString(1);
  } catch (e) {
    return e instanceof RangeError ? "RangeError: " + e.message : "other";
  }
}
console.log(badRadix(8));

// Boolean.prototype on an Unknown receiver (plan-notes 372): toString/valueOf/toLocaleString
// resolve instead of aborting STA2006.
function booleans(b) {
  return [b.toString(), b.valueOf(), b.toLocaleString(), typeof b.valueOf()].join(" ");
}
console.log(booleans(true));
console.log(booleans(false));

// Number.prototype.valueOf on an Unknown receiver answers the primitive itself (plan-notes 372).
function valueOf(n) {
  return n.valueOf() + " " + typeof n.valueOf();
}
console.log(valueOf(1.5));
console.log(valueOf(0));
console.log(valueOf(-3));

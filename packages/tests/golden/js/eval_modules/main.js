// Compiled modules, a direct eval reading and writing a caller's locals, an indirect eval and
// `new Function`, all in one program (plan T14.3).
import { label, scale } from './lib.js';

const scaled = scale(4);

function direct(base) {
  let seen = base + 1;
  const read = eval('seen * 2 + scaled');
  eval('seen = seen + 100');
  return [read, seen];
}
console.log(direct(1));

// Eval sees local bindings, not imports: an import is read through one.
const viaLocal = label;
const scaleFn = scale;
console.log(eval('viaLocal + ":" + typeof scaleFn'));

const indirect = (0, eval)('typeof viaLocal');
console.log(indirect);

const add = new Function('a', 'b', 'return a + b');
console.log(add(scaled, 1));
console.log(Function('return this')() === undefined);

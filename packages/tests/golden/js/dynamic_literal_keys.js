// Literal keys the object layout does not declare, stored function fields, Function.prototype.apply on array methods.
const argv = { _: [] };
argv['--'] = ['a'];
argv['x-y'] = 3;
console.log(argv['--'].length, argv['x-y'], argv['nope']);
const flags = { unknownFn: null, n: 1 };
function setup(o) { if (typeof o.unknown === 'function') flags.unknownFn = o.unknown; }
setup({ unknown: function (a) { return a + '!'; } });
console.log(flags.unknownFn ? flags.unknownFn('hi') : 'none');
const xs = [1];
xs.push.apply(xs, [2, 3]);
console.log(xs.length);
function f(args) {
  var argv = { _: [] };
  for (var i = 0; i < args.length; i++) {
    if (args[i] === 'stop') {
      var rest = args.slice(i + 1); argv._.push.apply(argv._, rest);
      break;
    }
  }
  return argv._;
}
console.log(f(['a', 'stop', 'b', 'c']));

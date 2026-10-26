var parse = require('./minimist.cjs');
function show(args, opts) { console.log(JSON.stringify(parse(args, opts))); }
show(['-x', '3', '--foo=bar', '-abc', 'pos', '--no-q']);
show(['--name', 'n', '-v', '--', 'rest', '-z'], { '--': true });
show(['-n5', '--num', '0x10', '--str', '007'], { string: ['str'] });
show(['--flag', 'x', '--b', 'true'], { boolean: ['flag', 'b'] });
show(['-h'], { alias: { h: 'help' }, default: { color: 'red' } });
show(['--a.b', '1', '--a.c=2', 'stop', '--late'], { stopEarly: true });
show(['--unknown', 'u', '--known', 'k'], { string: ['known'], unknown: function (a) { return a !== '--unknown'; } });
show(['-abc12', '--x=', '--y', '-']);

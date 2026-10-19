// print_regexp.ts — the ground truth for print_regexp.c. Same patterns, same order, console.log.
// If these two files drift apart the diff is meaningless, so edit them together.

const showTest = (re: RegExp, subject: string): void => {
  console.log(re.test(subject));
};

console.log(/a/);
console.log(/ab+c/gi);
console.log(new RegExp(''));
console.log(/\d+/gimsuy);
console.log([/x/g, 'after']);
console.log(JSON.stringify(/a/g));

const digits = /^[0-9]+$/;
showTest(digits, '123');
showTest(digits, '12a');
showTest(digits, '');
const word = /\bcat\b/;
showTest(word, 'a cat here');
showTest(word, 'concatenate');
const alt = /^(?:foo|bar)$/;
showTest(alt, 'foo');
showTest(alt, 'bar');
showTest(alt, 'baz');

const ci = /stra(ss|ß)e/i;
showTest(ci, 'STRASSE');
showTest(ci, 'Straße');
showTest(/ä/i, 'Ä');
showTest(/ä/, 'Ä');

const dot = /a.b/;
showTest(dot, 'a\nb');
showTest(/a.b/s, 'a\nb');
showTest(/^b/, 'a\nb');
showTest(/^b/m, 'a\nb');

showTest(/^.$/, '\u{1F600}');
showTest(/^.$/u, '\u{1F600}');
showTest(/\p{Letter}/u, 'é');
showTest(/\p{Letter}/u, '1');

showTest(/(ab)\1/, 'abab');
showTest(/(ab)\1/, 'abcd');
showTest(/foo(?=bar)/, 'foobar');
showTest(/foo(?=bar)/, 'foobaz');
showTest(/(?<!a)b/, 'cb');
showTest(/(?<!a)b/, 'ab');
showTest(/(?<year>[0-9]{4})/, 'in 2026');

const global = /a/g;
showTest(global, 'aab');
showTest(global, 'aab');
showTest(global, 'aab');
showTest(global, 'aab');
const sticky = /a/y;
showTest(sticky, 'ba');
showTest(sticky, 'ab');
showTest(sticky, 'ab');
const plain = /a/;
showTest(plain, 'aa');
showTest(plain, 'aa');

const pair = /(\d+)-(\w+)/;
console.log(pair.exec('12-ab'));
console.log(pair.exec('nope'));
const optional = /a(x)?(b)/;
console.log(optional.exec('ab'));
const named = /(?<year>\d{4})-(?<month>\d{2})/;
console.log(named.exec('2026-09'));
console.log((named.exec('2026-09') as RegExpExecArray).index);
const walker = /a/g;
console.log(walker.exec('aab'));
console.log(walker.exec('aab'));
console.log(walker.exec('aab'));
console.log('12-ab'.match(pair));
console.log('a bc def'.match(/[a-z]+/g));
console.log('a bc def'.match(/z/g));
console.log('a bc def'.match(/z/));

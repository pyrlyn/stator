import { ms, format, parse, parseStrict } from './ms.ts';
console.log(parse('2 days'), parse('1h'), parse('-1.5h'), parse('100'), parse('1y'), parse('nope'));
console.log(format(60000), format(2 * 86400000, { long: true }), format(-3 * 3600000), format(999), format(1000, { long: true }));
console.log(ms('10s'), ms(1500), ms(36e5, { long: true }), parseStrict('5m'));
try { format(NaN); } catch (e) { console.log('threw', (e as Error).message); }

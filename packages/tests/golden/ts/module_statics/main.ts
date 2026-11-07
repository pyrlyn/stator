// A static of an imported class is the declaring module's binding (plan/T11.6): the importer
// reads it, assigns it, runs its accessor and calls it, at the top level and inside a function,
// and an inherited static resolves to the base's one binding.
import { Bytes, Named, Registry } from './registry.ts';
import { touch } from './user.ts';

console.log(Registry.count, Registry.label, Registry.next(), Registry.secret);
Registry.count++;
console.log(touch(), Named.count, Named.next(), Registry.count);
console.log(Bytes.of2(1, 2).length, Bytes.of2(3, 4) instanceof Bytes);

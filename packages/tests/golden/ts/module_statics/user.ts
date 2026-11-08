// A second module: reads, writes and calls the imported classes' statics inside a function.
import { Bytes, Named, Registry } from './registry.ts';

export function touch(): string {
  Registry.count += 10;
  Registry.label = 'touched';
  Registry.secret = 5;
  const bytes = Bytes.of2(7, 9);
  return `${Registry.next()} ${Named.describe()} ${Registry.secret} ${bytes[1]}`;
}

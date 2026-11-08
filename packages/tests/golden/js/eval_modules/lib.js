// A compiled module the evaluating program imports: its exports reach the eval only through the
// importer's own bindings.
export function scale(n) {
  return n * 3;
}

export const label = 'lib';

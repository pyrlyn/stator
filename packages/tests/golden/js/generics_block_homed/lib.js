// Untyped values: in js mode a block-homed generic called with these takes the Unknown tuple.
export function sample() {
  return { count: 7, label: "seven", flags: [true, false] };
}
export function twice(f, v) {
  return f(f(v));
}

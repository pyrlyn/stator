// @mode: ts
// @verdict: dynamic
// SUBSET.md: Class-object reads -- a static read or static method call through a class
// VALUE (`k: typeof C` holding C or a subclass) goes through the descriptor's statics table
// at run time (docs/VALUE.md §4.26, T27); the read is checked as its declared type.

class C {
  static count = 2;
  static label(): string {
    return 'c';
  }
}
class D extends C {}
function read(k: typeof C): string {
  return `${k.count} ${k.label()} ${k.name} ${k.length}`;
}
console.log(read(C), read(D));

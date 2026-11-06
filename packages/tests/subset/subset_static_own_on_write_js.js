// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Static methods and static class members
// Writing an inherited static through a subclass creates the subclass's OWN property in
// JavaScript (Node prints `0 5`); one binding per static cannot hold the second value, so
// the write is refused rather than compiled into the base's binding.

class S {
  static count = 0;
}
class T extends S {}
T.count = 5;
console.log(S.count, T.count);

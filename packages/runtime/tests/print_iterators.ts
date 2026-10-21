function* gen() {}
const generator = gen();
const iterator = [][Symbol.iterator]();
for (const receiver of [undefined, null, true, 1, {}, []]) {
  for (const method of [iterator.next, iterator.next, generator.return, generator.throw]) {
    try {
      method.call(receiver);
      throw new Error('receiver unexpectedly accepted');
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      console.log(error.name);
    }
  }
}

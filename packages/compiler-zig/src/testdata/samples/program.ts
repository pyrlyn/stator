interface Shape {
  readonly kind: 'circle' | 'square';
  area(): number;
}

type Pair<A, B> = readonly [A, B];

export async function* walk<T extends Shape>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) {
    if (item.kind === 'circle') {
      yield item;
    } else {
      switch (item.kind) {
        case 'square':
          continue;
        default:
          throw new Error(`unknown ${item.kind}`);
      }
    }
  }
}

const total = [1, 2, 3].reduce((sum, x) => sum + x, 0) satisfies number;
label: while (true) {
  break label;
}

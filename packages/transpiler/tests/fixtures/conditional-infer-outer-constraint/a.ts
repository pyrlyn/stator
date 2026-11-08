// `infer Y extends S` reads `S` as the alias was given it, so the conditional resolves instead
// of staying deferred on a type parameter (execa's `MergeOptions`).
interface Opts { r?: boolean; b?: boolean }
type Bound<X, S extends Opts = Opts> = X extends infer Y extends S ? Y : never;
type Pick2<A, X, S extends Opts = Opts> = [A] extends [Record<PropertyKey, never>] ? X : S;
type Merge<A, X, S extends Opts = Opts> = Pick2<A, X, S> extends infer Y extends S ? Y : never;
declare class Box<T> { value: T }
declare const b1: Box<Bound<{ r: false }>>;
declare const b2: Box<Merge<{}, { r: false }>>;
declare const b3: Box<Bound<{ r: 1 }>>;
const v1: { r: false } = b1.value;
const v2: { r: false } = b2.value;
const v3: { r: 1 } = b3.value;

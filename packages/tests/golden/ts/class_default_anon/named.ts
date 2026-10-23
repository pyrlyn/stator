// A named default class keeps its own `.name` (plan.md §8 step 12(d)).
export default class Named {
  kind: string = "named";
  who(): string {
    return this.kind;
  }
}

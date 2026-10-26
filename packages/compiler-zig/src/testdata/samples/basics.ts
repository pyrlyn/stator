#!/usr/bin/env node
// A line comment.
/* A block
   comment. */
import { readFile } from 'node:fs';
export const answer: number = 42;
let s = "double \"quoted\"" + 'single \'quoted\'';
function add(a: number, b: number): number {
  return a + b;
}
class Box<T> {
  #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  get value(): T {
    return this.#value;
  }
}

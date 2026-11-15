// Virtual method dispatch over a class hierarchy: the call site sees three receiver classes,
// so neither monomorphization nor inlining can resolve it to one body.
abstract class Shape {
  abstract area(): number;
  scaled(factor: number): number {
    return this.area() * factor;
  }
}

class Square extends Shape {
  readonly side: number;
  constructor(side: number) {
    super();
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}

class Rect extends Shape {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    super();
    this.width = width;
    this.height = height;
  }
  area(): number {
    return this.width * this.height;
  }
}

class Tri extends Shape {
  readonly base: number;
  readonly height: number;
  constructor(base: number, height: number) {
    super();
    this.base = base;
    this.height = height;
  }
  override scaled(factor: number): number {
    return super.scaled(factor) + 1;
  }
  area(): number {
    return (this.base * this.height) / 2;
  }
}

const shapes: Shape[] = [];
for (let i = 0; i < 1000; i += 1) {
  const k = i % 3;
  shapes.push(k === 0 ? new Square(i % 7) : k === 1 ? new Rect(i % 5, i % 11) : new Tri(i % 13, 4));
}
let total: number = 0;
for (let round = 0; round < 2000; round += 1) {
  for (const shape of shapes) total += shape.scaled(round % 3);
}
console.log(total);

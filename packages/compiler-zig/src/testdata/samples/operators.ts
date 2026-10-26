a = b + c - d * e / f % g ** h;
a += 1; a -= 1; a *= 2; a /= 2; a %= 3; a **= 2;
a <<= 1; a >>= 1; a >>>= 1; a &= 1; a |= 1; a ^= 1;
a &&= b; a ||= b; a ??= b;
x = a == b || a != b && a === b || a !== b;
y = a < b ? a <= b : a > b ? a >= b : !a;
z = ~a & b | c ^ d << 2 >> 3 >>> 4;
i++; i--; ++i; --i;
o?.p?.[0]?.(1) ?? q;
t = c ? .5 : 1;
f = (...args) => args;
@decorator class C {}

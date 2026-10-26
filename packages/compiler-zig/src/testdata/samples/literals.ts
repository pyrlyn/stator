const n = [0, 1, 1_000_000, 3.14, .5, 1e10, 2.5E-3, 0x1F, 0b1010, 0o777, 10n, 0xffn];
const s = ['', "", 'a\nb', "tab\t", '\u0041', "\\"];
const t = `plain`;
const u = `head ${n[0]} middle ${s} tail`;
const v = `outer ${`inner ${1 + 2} done`} after`;
const w = `obj ${ { a: 1 }.a } end`;
const b = [true, false, null, undefined];

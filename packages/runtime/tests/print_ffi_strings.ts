// print_ffi_strings.ts — the ground truth for print_ffi_strings.c. Same lines, same order.
// If these two files drift apart the diff is meaningless, so edit them together.
//
// OUT lines ask Buffer what Node decodes the same bytes to; IN lines log the text whose
// UTF-8 encoding is the bytes the C side printed.

const show = (v: unknown): void => console.log(v);

show('hello');
show('');
show('héllo → ✓ 😀');

show(Buffer.from([0xe1, 0x80, 0xe1, 0x80, 0x80]).toString('utf8'));
show(Buffer.from([0xc0, 0xaf]).toString('utf8'));
show(Buffer.from([0xed, 0xa0, 0x80]).toString('utf8'));
show(Buffer.from([0xf0, 0x90, 0x80]).toString('utf8'));
show(Buffer.from([0x80]).toString('utf8'));
show(Buffer.from([0xf4, 0x90, 0x80, 0x80]).toString('utf8'));
show(Buffer.from([0xe0, 0x80, 0x80]).toString('utf8'));
show(Buffer.from([0xe1, 0x80]).toString('utf8'));

show('hello');
show('');
show('héllo → ✓ 😀');
show('A😀B');

show('h');
// A lone lead surrogate encodes as U+FFFD on the way in.
show('\ufffd');
// So does a lone trail surrogate.
show('\ufffd');

show('café → ✓');

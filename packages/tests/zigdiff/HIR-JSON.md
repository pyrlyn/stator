# HIR-JSON

The HIR as text: what the TypeScript compiler (the oracle) hands to the Zig passes and the Zig
emitter, and what the Zig passes print to be compared with it. `dump-hir.ts` writes it and
`packages/compiler-zig/src/hir/json.zig` reads and writes it.

```
node packages/tests/zigdiff/dump-hir.ts <entry> <out-dir> [--mode=ts|js] [--node]
```

This runs the sequence of `compileToCInner` in `cli/build.ts` and writes `lowered.json` (right after
`lowerProgram`) and `optimized.json` (after `optimize`, what `emitC` receives). A program a stage
refuses writes nothing and exits 1 with its diagnostics; the verifier rejecting the optimized HIR
throws, as it does in a build. From TypeScript, `dumpHir` returns the two `Module`s as well and
`hirJson` encodes any `Module`.

## Canonical means byte for byte

One document has one spelling, so two dumps are equal exactly when their bytes are. A document is
one line with no trailing newline and no whitespace, and everything below is what
`JSON.stringify` prints: `json.zig` reproduces it, and the comparison is `===` on the text.

```json
{"format":1,"files":["/abs/a.ts"],"types":[{"kind":"number"}],"module":{"kind":"module",...}}
```

The four top-level keys come in this order, because the tables must precede the module that names
them. The keys of an object are `kind`, then `$id` if present, then the rest sorted by code unit. A
key whose value is `undefined` does not appear; the reader refuses an explicit `null` there. The
only `null` is a position in `ExternCall.argTags`, where `undefined` means "no tag" and the position
matters.

The tree is walked in that key order, and `$id`s, `types` and `files` are numbered by first
encounter in that walk, so the numbering is a function of the tree.

## Nodes and identity

A node is an object with `kind`, `span` and `type`, spelled as in `hir/nodes.ts`, keys included.
`kind` alone does not make a node: `StaticProp` has an ordinary `kind` field that can even read
`"set"`, so it sits in its sorted place like any other key.

Node identity is observable: the emitter's slot and label maps are keyed by node object. A node
reached twice is written whole the first time with `"$id": N`, in pre-order from 0, and after that
as `{"$ref": N}`. The reader hands back the same pointer for both. A node reached once has no id.

The HIR holds no cycles, no `Map`, `Set` or symbol keys, and no class instances. The walk throws on
each of these rather than skipping it, and the reader refuses a `$ref` into a node still open, so
neither side can build a cycle.

## Types

Key `type`, and every type inside a type, is an index into `types`. An entry spells one `HType`
(`kind`, then sorted keys) with its child types as indices.

Entries are interned on that text, children first. An entry can therefore only name lower indices,
and untrusted input cannot make a cycle. Interning merges separate objects that spell one type,
which loses nothing: no code below the gate compares types by address. `hTypeEquals` is the only
comparison, and classes compare by name.

## Scalars

| TS value | JSON |
| --- | --- |
| `Span {start, length, line, file?}` | `[start, length, line]`, or `[start, length, line, fileId]` into `files`, in first-encounter order |
| `NumberLiteral.value` | 16 lowercase hex digits, the IEEE-754 bits, so `-0`, NaN and the infinities survive. Every NaN is `7ff8000000000000`, because JavaScript has one NaN |
| other numbers | integers, `JSON.stringify` spelling; a non-integer throws in the dump |
| strings | `JSON.stringify` escapes: `\"`, `\\`, `\b\f\n\r\t`, other controls `\u00xx`, a lone surrogate lowercase `\udxxx`, everything else raw UTF-8 |

Zig holds strings as WTF-8: a lone surrogate is its 3-byte form, a surrogate pair is one 4-byte code
point. Zig code that concatenates strings must join a trailing high surrogate and a leading low one
into that one code point, as JavaScript's `+` effectively does, or `json.zig` prints two escapes
where the dump has the character.

## Dynamic entries

`DynEntry` is the one union TypeScript discriminates by which keys exist (`'get' in entry`), and an
accessor's absent half is `undefined`, which has no JSON form. Under `dyn-object-literal.entries`
each entry therefore carries a synthetic `kind`: `object-entry`, `accessor-entry` or
`computed-entry`.

## The reader

`read(arena, text, &failure)` treats the text as untrusted: a bad document is
`error.InvalidHirJson` with an offset and a reason, never a panic. It refuses anything not valid
UTF-8, unknown and duplicate keys, missing required keys, unknown kinds and enum values, a node of
the wrong kind in a typed position, a type id that is not an earlier entry, ids out of sequence,
non-canonical numbers and text after the document. Limits: `MAX_DEPTH` open arrays and objects
and `MAX_TYPE_DEPTH` nested types, both well above what the corpus reaches.

An unknown key being an error is the other half of "nothing is silently dropped": the dump walks
whatever a node holds without knowing its schema, so a field added to `nodes.ts` and not to
`nodes.zig` fails the next read.

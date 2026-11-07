// node:buffer under --node (plan.md §11c T11.6): `Buffer` extends `Uint8Array`, so it indexes and
// slices as a view and goes wherever one does; `Buffer.from` and `toString` take Node's encodings;
// `readFileSync` without an encoding answers a `Buffer`; and the free `Buffer` is the import.

import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';

interface Failure {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

function attempt(label: string, run: () => string): void {
  try {
    console.log(label, run());
  } catch (e) {
    const failure = e as Failure;
    console.log(label, failure.name, failure.code, failure.message);
  }
}

function sum(view: Uint8Array): number {
  let total = 0;
  for (const b of view) {
    total += b;
  }
  return total;
}

const text = Buffer.from('héllo, wörld');
console.log(text.length, text[0], text[1], text[2], text instanceof Buffer, text instanceof Uint8Array);
console.log(text.toString(), text.toString('utf8', 7), text.toString('hex', 0, 4));
console.log(text.toString('base64'), text.toString('base64url'), text.toString('latin1', 0, 3));
console.log(text.toString('ascii', 0, 3), text.toString('UTF-8', 2, 100), sum(text));
console.log(Buffer.from('aGVsbG8=', 'base64').toString(), Buffer.from('68656c6c6f', 'hex').toString());
console.log(Buffer.from('hi', 'utf16le').length, Buffer.from('hi', 'ucs2').toString('utf16le'));
console.log(Buffer.from('ÿé', 'latin1').toString('hex'), Buffer.from('', 'base64').length);
console.log(Buffer.from([104, 105, 300, -1]).toString('hex'), Buffer.from(new Uint8Array([1, 2])).length);
console.log(text.toString('utf8', 3, 2) === '', text.toString('utf8', 99), text.toString('utf8', -5, 1));
attempt('bad encoding', () => text.toString('nope'));
attempt('empty encoding', () => text.toString(''));
attempt('bad from encoding', () => Buffer.from('x', 'nope').toString());
console.log(text.toString('nope', 99) === '', Buffer.from('x', '').toString());

const sub = text.subarray(0, 5);
console.log(sub instanceof Buffer, sub.toString(), text.slice(7).toString());
sub[0] = 72;
const shared = text.slice(-5);
shared[0] = 87;
console.log(text.toString('utf8', 7), text.subarray(-3, -1).toString(), text.slice(NaN, 2).toString());
console.log(text.toString('utf8', 0, 5), Buffer.isBuffer(sub), Buffer.isBuffer(new Uint8Array(1)));
console.log(Buffer.isEncoding('UTF8'), Buffer.isEncoding('binary'), Buffer.isEncoding(''), Buffer.isEncoding(1));
console.log(Buffer.byteLength('héllo'), Buffer.byteLength('héllo', 'latin1'), Buffer.byteLength('ab', 'ucs2'));
console.log(Buffer.byteLength('aGk=', 'base64'), Buffer.byteLength(text), Buffer.byteLength('x', 'nope'));
console.log(Buffer.alloc(3).toString('hex'), Buffer.alloc(0).length);
const joined = Buffer.concat([Buffer.from('ab'), new Uint8Array([99]), Buffer.from('de')]);
console.log(joined.toString(), Buffer.concat([joined, joined], 7).toString(), Buffer.concat([joined], 8).toString('hex'));
console.log(Buffer.concat([]).length, joined.equals(Buffer.from('abcde')), joined.equals(Buffer.from('abcdf')));
const big = Buffer.from('abcdef');
console.log(Buffer.copyBytesFrom(big).toString(), Buffer.copyBytesFrom(big, 2).toString(), Buffer.copyBytesFrom(big, 1, 2).toString());
console.log(Buffer.copyBytesFrom(big, 9).length, Buffer.copyBytesFrom(big, 4, 9).toString(), Buffer.copyBytesFrom(new Uint8Array(0)).length);
attempt('fraction offset', () => Buffer.copyBytesFrom(big, 1.5).toString());
attempt('negative length', () => Buffer.copyBytesFrom(big, 0, -1).toString());
attempt('huge offset', () => Buffer.copyBytesFrom(big, 2 ** 60).toString());

const dir = `/tmp/stator_node_buffer_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
mkdirSync(dir);
const file = `${dir}/bytes.bin`;
writeFileSync(file, Buffer.from('﻿bom'));
const bytes: Buffer = readFileSync(file);
console.log(bytes.length, bytes[0], bytes instanceof Buffer, bytes.toString('utf8', 3), bytes.toString('hex'));
unlinkSync(file);
rmdirSync(dir);

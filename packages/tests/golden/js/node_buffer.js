// node:buffer in js mode under --node (plan.md §11c T11.6): the global `Buffer`, untyped values
// crossing into the typed class, and tsc's own `readFile`, which reads a file's
// `Buffer` byte by byte, swaps UTF-16BE in place and decodes past the byte-order mark.

import fs from 'node:fs';

const base64encode = (input) => Buffer.from(input).toString('base64');
const base64decode = (input) => Buffer.from(input, 'base64').toString('utf8');
console.log(base64encode('{"version":3}'), base64decode(base64encode('héllo')));
console.log(Buffer.isBuffer(Buffer.from('')), Buffer.isBuffer(new Uint8Array(1)), Buffer.isBuffer('x'));

function readFile(fileName) {
  let buffer;
  try {
    buffer = fs.readFileSync(fileName);
  } catch {
    return void 0;
  }
  let len = buffer.length;
  if (len >= 2 && buffer[0] === 254 && buffer[1] === 255) {
    len &= ~1;
    for (let i = 0; i < len; i += 2) {
      const temp = buffer[i];
      buffer[i] = buffer[i + 1];
      buffer[i + 1] = temp;
    }
    return buffer.toString('utf16le', 2);
  }
  if (len >= 2 && buffer[0] === 255 && buffer[1] === 254) {
    return buffer.toString('utf16le', 2);
  }
  if (len >= 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191) {
    return buffer.toString('utf8', 3);
  }
  return buffer.toString('utf8');
}

const dir = `/tmp/stator_node_buffer_js_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
fs.mkdirSync(dir);
const cases = [
  ['plain', Buffer.from('let x = 1;')],
  ['utf8 bom', Buffer.from('﻿let é = 2;')],
  ['utf16le bom', Buffer.concat([Buffer.from([255, 254]), Buffer.from('let y = 3;', 'utf16le')])],
  ['utf16be bom', Buffer.from([254, 255, 0, 0x7a, 0, 0x3d, 0, 0x34])],
];
for (const entry of cases) {
  const name = entry[0];
  const data = entry[1];
  const file = `${dir}/${name.replace(' ', '_')}.ts`;
  fs.writeFileSync(file, data);
  console.log(name, JSON.stringify(`${readFile(file)}`), Buffer.isBuffer(fs.readFileSync(file)));
  fs.unlinkSync(file);
}
console.log(readFile(`${dir}/missing.ts`));
fs.rmdirSync(dir);

const untyped = [1, 2, 3];
const view = Buffer.from(untyped);
console.log(view.length, view[2], view.toString('hex'), typeof view.toString, Buffer.byteLength('ab'));

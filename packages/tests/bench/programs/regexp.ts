// The vendored libregexp on the paths programs hit: test, exec with captures, global replace and
// split. The input is rebuilt each round so no compile-time fold can precompute a match.
const word = /^([a-z]+)(\d+)/;
const digits = /\d+/g;
let checksum: number = 0;
for (let round = 0; round < 12_000; round += 1) {
  const line = `id${String(round)} user${String(round % 97)} at host${String(round % 13)}.example ok`;
  if (/host\d+\.example/.test(line)) checksum += 1;
  const match = word.exec(line);
  if (match !== null) checksum += (match[1] ?? '').length + Number(match[2] ?? '0');
  checksum += line.replace(digits, '#').length;
  checksum += line.split(/\s+/).length;
}
console.log(checksum);

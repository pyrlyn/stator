// Node-side oracle for the SQLite FFI demo (examples/ffi/sqlite/): the same
// calls the Stator side makes as direct C calls, spelled in JS over the
// pinned Node's built-in `node:sqlite` (DatabaseSync, in-memory). Codes are
// RETURNED, never thrown — the demo checks codes / compares step results
// itself, so the shared source runs on both sides. `sqlite3Open` fills an
// `outSlot()` `{value}` cell; `sqlite3PrepareV2` takes C parameter order
// `(db, sql, nByte, stmtSlot, tailSlot)` with `nByte = -1` meaning
// NUL-terminated, and reports the single-statement tail as `""`. Row state
// lives in JS closures keyed by object identity (the Map below).
import { DatabaseSync } from 'node:sqlite';

const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

const DBS = new Map();
let cachedVersion = 0;

function isSlot(x) {
  return x !== null && typeof x === 'object' && 'value' in x;
}

function unwrap(x) {
  return isSlot(x) ? x.value : x;
}

function dbOf(handle) {
  const rec = DBS.get(unwrap(handle));
  if (rec === undefined) throw new Error('sqlite3 oracle: bad db handle');
  return rec;
}

function start(rec) {
  if (rec.started) return true;
  rec.started = true;
  try {
    if (/^\s*(select|values|with|explain|pragma)\b/i.test(rec.sql)) {
      rec.rows = rec.stmt.all(...rec.params);
    } else {
      const info = rec.stmt.run(...rec.params);
      rec.dbr.changes = Number(info.changes);
      rec.rows = [];
    }
    rec.index = -1;
    return true;
  } catch (e) {
    rec.dbr.errmsg = e instanceof Error ? e.message : String(e);
    return false;
  }
}

globalThis.outSlot = () => ({ value: undefined });

globalThis.sqlite3Open = (filename, slot) => {
  const handle = { __sqliteDb: true };
  try {
    DBS.set(handle, {
      db: new DatabaseSync(filename ?? ':memory:'),
      errmsg: 'not an error',
      changes: 0,
    });
  } catch {
    return 1;
  }
  if (isSlot(slot)) {
    slot.value = handle;
    return 0;
  }
  return handle;
};

globalThis.sqlite3PrepareV2 = (dbHandle, sql, nByte, stmtSlot, tailSlot) => {
  const dbr = dbOf(dbHandle);
  let text = String(sql);
  let tail = '';
  if (nByte >= 0) {
    const bytes = Buffer.from(text, 'utf8');
    const head = bytes.subarray(0, nByte).toString('utf8');
    tail = bytes.subarray(Buffer.byteLength(head, 'utf8')).toString('utf8');
    text = head;
  }
  let stmt;
  try {
    stmt = dbr.db.prepare(text);
  } catch (e) {
    dbr.errmsg = e instanceof Error ? e.message : String(e);
    if (isSlot(tailSlot)) tailSlot.value = tail;
    return 1;
  }
  const rec = { dbr, stmt, sql: text, params: [], rows: null, index: -1, started: false };
  if (isSlot(stmtSlot)) stmtSlot.value = rec;
  if (isSlot(tailSlot)) tailSlot.value = tail;
  return 0;
};

globalThis.sqlite3BindInt = (stmtHandle, index, value) => {
  unwrap(stmtHandle).params[index - 1] = Math.trunc(value);
  return 0;
};

globalThis.sqlite3BindDouble = (stmtHandle, index, value) => {
  unwrap(stmtHandle).params[index - 1] = value;
  return 0;
};

globalThis.sqlite3Step = (stmtHandle) => {
  const rec = unwrap(stmtHandle);
  if (!start(rec)) return 1;
  rec.index += 1;
  return rec.index < rec.rows.length ? SQLITE_ROW : SQLITE_DONE;
};

function columnAt(stmtHandle, col) {
  const rec = unwrap(stmtHandle);
  return Object.values(rec.rows[rec.index])[col];
}

globalThis.sqlite3ColumnInt = (stmtHandle, col) => {
  const v = columnAt(stmtHandle, col);
  return v === null || v === undefined ? 0 : Math.trunc(Number(v));
};

globalThis.sqlite3ColumnDouble = (stmtHandle, col) => {
  const v = columnAt(stmtHandle, col);
  return v === null || v === undefined ? 0 : Number(v);
};

globalThis.sqlite3ColumnText = (stmtHandle, col) => {
  const v = columnAt(stmtHandle, col);
  // The cast erases. String() is what the oracle has always done, including a typed-array
  // cell's comma-joined bytes; the annotation only tells the linter the value is scalar.
  return v === null || v === undefined ? null : String(v as string | number | bigint);
};

globalThis.sqlite3Finalize = (stmtHandle) => {
  const rec = unwrap(stmtHandle);
  rec.started = true;
  rec.rows = [];
  rec.index = 0;
  return 0;
};

globalThis.sqlite3Close = (dbHandle) => {
  const handle = unwrap(dbHandle);
  const rec = dbOf(handle);
  rec.db.close();
  DBS.delete(handle);
  return 0;
};

globalThis.sqlite3Errmsg = (dbHandle) => dbOf(dbHandle).errmsg;

globalThis.sqlite3Changes = (dbHandle) => dbOf(dbHandle).changes;

globalThis.sqlite3LibversionNumber = () => {
  if (cachedVersion !== 0) return cachedVersion;
  const db = new DatabaseSync(':memory:');
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get();
    const [major, minor, patch] = String(row.v).split('.').map(Number);
    cachedVersion = major * 1000000 + minor * 1000 + patch;
    return cachedVersion;
  } finally {
    db.close();
  }
};

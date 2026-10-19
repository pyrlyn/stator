// Node-side oracle for the SQLite FFI demo (examples/ffi/sqlite/): the same
// calls the Stator side makes as direct C calls, spelled in JS over the
// pinned Node's built-in `node:sqlite` (DatabaseSync, in-memory). Codes are
// RETURNED, never thrown — the demo checks codes / compares step results
// itself, so the shared source runs on both sides. `sqlite3Open` fills an
// `outSlot()` `{value}` cell; `sqlite3PrepareV2` takes C parameter order
// `(db, sql, nByte, stmtSlot, tailSlot)` with `nByte = -1` meaning
// NUL-terminated, and reports the single-statement tail as `""`. Row state
// lives in JS closures keyed by object identity (the Map below).
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';

type Bindings = Record<string, unknown>;
const bindings = globalThis as unknown as Bindings;

const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

interface Slot {
  value: unknown;
}

interface DbRec {
  db: DatabaseSync;
  errmsg: string;
  changes: number;
}

interface StmtRec {
  dbr: DbRec;
  stmt: StatementSync;
  sql: string;
  params: SQLInputValue[];
  rows: Record<string, SQLOutputValue>[] | null;
  index: number;
  started: boolean;
}

const DBS = new Map<object, DbRec>();
let cachedVersion = 0;

function isSlot(x: unknown): x is Slot {
  return x !== null && typeof x === 'object' && 'value' in x;
}

function unwrap(x: unknown): unknown {
  return isSlot(x) ? x.value : x;
}

function asObject(x: unknown): object {
  const value = unwrap(x);
  if (value === null || typeof value !== 'object') {
    throw new Error('sqlite3 oracle: bad handle');
  }
  return value;
}

function dbOf(handle: unknown): DbRec {
  const rec = DBS.get(asObject(handle));
  if (rec === undefined) throw new Error('sqlite3 oracle: bad db handle');
  return rec;
}

function asStmt(handle: unknown): StmtRec {
  return unwrap(handle) as StmtRec;
}

function start(rec: StmtRec): boolean {
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

bindings['outSlot'] = (): Slot => ({ value: undefined });

bindings['sqlite3Open'] = (filename: string | null | undefined, slot: unknown): number | object => {
  const handle: object = { __sqliteDb: true };
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

bindings['sqlite3PrepareV2'] = (
  dbHandle: unknown,
  sql: unknown,
  nByte: number,
  stmtSlot: unknown,
  tailSlot: unknown,
): number => {
  const dbr = dbOf(dbHandle);
  let text = String(sql);
  let tail = '';
  if (nByte >= 0) {
    const bytes = Buffer.from(text, 'utf8');
    const head = bytes.subarray(0, nByte).toString('utf8');
    tail = bytes.subarray(Buffer.byteLength(head, 'utf8')).toString('utf8');
    text = head;
  }
  let stmt: StatementSync;
  try {
    stmt = dbr.db.prepare(text);
  } catch (e) {
    dbr.errmsg = e instanceof Error ? e.message : String(e);
    if (isSlot(tailSlot)) tailSlot.value = tail;
    return 1;
  }
  const rec: StmtRec = { dbr, stmt, sql: text, params: [], rows: null, index: -1, started: false };
  if (isSlot(stmtSlot)) stmtSlot.value = rec;
  if (isSlot(tailSlot)) tailSlot.value = tail;
  return 0;
};

bindings['sqlite3BindInt'] = (stmtHandle: unknown, index: number, value: number): number => {
  asStmt(stmtHandle).params[index - 1] = Math.trunc(value);
  return 0;
};

bindings['sqlite3BindDouble'] = (stmtHandle: unknown, index: number, value: number): number => {
  asStmt(stmtHandle).params[index - 1] = value;
  return 0;
};

bindings['sqlite3Step'] = (stmtHandle: unknown): number => {
  const rec = asStmt(stmtHandle);
  if (!start(rec)) return 1;
  rec.index += 1;
  const rows = rec.rows;
  if (rows === null) return 1;
  return rec.index < rows.length ? SQLITE_ROW : SQLITE_DONE;
};

function columnAt(stmtHandle: unknown, col: number) {
  const rec = asStmt(stmtHandle);
  const rows = rec.rows;
  if (rows === null) throw new Error('sqlite3 oracle: no rows');
  const row = rows[rec.index];
  if (row === undefined) throw new Error('sqlite3 oracle: no row');
  return Object.values(row)[col];
}

bindings['sqlite3ColumnInt'] = (stmtHandle: unknown, col: number): number => {
  const v = columnAt(stmtHandle, col);
  return v === null || v === undefined ? 0 : Math.trunc(Number(v));
};

bindings['sqlite3ColumnDouble'] = (stmtHandle: unknown, col: number): number => {
  const v = columnAt(stmtHandle, col);
  return v === null || v === undefined ? 0 : Number(v);
};

bindings['sqlite3ColumnText'] = (stmtHandle: unknown, col: number): string | null => {
  const v = columnAt(stmtHandle, col);
  return v === null || v === undefined ? null : String(v);
};

bindings['sqlite3Finalize'] = (stmtHandle: unknown): number => {
  const rec = asStmt(stmtHandle);
  rec.started = true;
  rec.rows = [];
  rec.index = 0;
  return 0;
};

bindings['sqlite3Close'] = (dbHandle: unknown): number => {
  const handle = asObject(dbHandle);
  const rec = dbOf(handle);
  rec.db.close();
  DBS.delete(handle);
  return 0;
};

bindings['sqlite3Errmsg'] = (dbHandle: unknown): string => dbOf(dbHandle).errmsg;

bindings['sqlite3Changes'] = (dbHandle: unknown): number => dbOf(dbHandle).changes;

bindings['sqlite3LibversionNumber'] = (): number => {
  if (cachedVersion !== 0) return cachedVersion;
  const db = new DatabaseSync(':memory:');
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get();
    if (row === undefined) throw new Error('sqlite3 oracle: no version');
    const parts = String(row['v'])
      .split('.')
      .map((part) => Number(part));
    const major = parts[0];
    const minor = parts[1];
    const patch = parts[2];
    if (major === undefined || minor === undefined || patch === undefined) {
      throw new Error('sqlite3 oracle: bad version');
    }
    cachedVersion = major * 1000000 + minor * 1000 + patch;
    return cachedVersion;
  } finally {
    db.close();
  }
};

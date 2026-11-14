import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { openIndexDb, withTransaction } from "../utils";

describe("SQLite index connections", () => {
  let dir: string;
  let path: string;
  let connections: DatabaseSync[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-search-sqlite-"));
    path = join(dir, "index.db");
    connections = [];
  });

  afterEach(() => {
    for (const db of connections) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function track(db: DatabaseSync): DatabaseSync {
    connections.push(db);
    return db;
  }

  // @lat: [[sqlite-tests#Pruebas de SQLite#WAL y lectores]]
  it("migrates to WAL without losing data and lets a writer commit beside a reader", () => {
    const seed = track(new DatabaseSync(path));
    seed.exec("CREATE TABLE entries (id INTEGER); INSERT INTO entries VALUES (1)");
    assert.equal(seed.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");

    const writer = track(openIndexDb(path));
    const reader = track(new DatabaseSync(path));
    assert.equal(writer.prepare("PRAGMA busy_timeout").get()!.timeout, 30000);
    assert.equal(reader.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
    reader.exec("BEGIN");
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM entries").get()!.n, 1);
    withTransaction(writer, () => writer.exec("INSERT INTO entries VALUES (2)"));
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM entries").get()!.n, 1);
    reader.exec("COMMIT");
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM entries").get()!.n, 2);
  });

  // @lat: [[sqlite-tests#Pruebas de SQLite#Apertura fallida]]
  it("propagates WAL setup errors and closes the failed connection", (t) => {
    writeFileSync(path, "not a SQLite database".repeat(100));
    const close = t.mock.method(DatabaseSync.prototype, "close");
    assert.throws(() => track(openIndexDb(path)), /file is not a database/);
    assert.equal(close.mock.callCount(), 1);
  });

  // @lat: [[sqlite-tests#Pruebas de SQLite#Migracion bloqueada]]
  it("does not silently continue in rollback mode when WAL conversion is locked", (t) => {
    const reader = track(new DatabaseSync(path));
    reader.exec("CREATE TABLE entries (id INTEGER); BEGIN");
    reader.prepare("SELECT * FROM entries").all();
    const exec = DatabaseSync.prototype.exec;
    // Keep this forced-lock test fast without changing the production timeout.
    t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      return exec.call(this, sql === "PRAGMA busy_timeout = 30000;" ? "PRAGMA busy_timeout = 0;" : sql);
    });
    const close = t.mock.method(DatabaseSync.prototype, "close");
    assert.throws(() => track(openIndexDb(path)), /database is locked/);
    assert.equal(close.mock.callCount(), 1);
    reader.exec("ROLLBACK");
    const retry = track(openIndexDb(path));
    assert.equal(retry.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  });

  // @lat: [[sqlite-tests#Pruebas de SQLite#Commit correcto]]
  it("commits the writes and returns the callback result", () => {
    const db = track(openIndexDb(path));
    db.exec("CREATE TABLE entries (id INTEGER)");
    const result = withTransaction(db, () => {
      db.exec("INSERT INTO entries VALUES (1)");
      return 42;
    });
    assert.equal(result, 42);
    const other = track(new DatabaseSync(path));
    assert.equal(other.prepare("SELECT COUNT(*) AS n FROM entries").get()!.n, 1);
  });

  // @lat: [[sqlite-tests#Pruebas de SQLite#Rollback del cuerpo]]
  it("rolls back partial writes, preserves the error and releases the writer lock", () => {
    const db = track(openIndexDb(path));
    db.exec("CREATE TABLE entries (id INTEGER); INSERT INTO entries VALUES (1)");
    const failure = new Error("abort the batch");
    assert.throws(() => withTransaction(db, () => {
      db.exec("DELETE FROM entries; INSERT INTO entries VALUES (2)");
      throw failure;
    }), (err) => err === failure);
    const other = track(new DatabaseSync(path));
    other.exec("PRAGMA busy_timeout = 0");
    assert.equal(other.prepare("SELECT id FROM entries").get()!.id, 1);
    withTransaction(other, () => other.exec("INSERT INTO entries VALUES (3)"));
    withTransaction(db, () => db.exec("INSERT INTO entries VALUES (4)"));
  });

  // @lat: [[sqlite-tests#Pruebas de SQLite#Rollback del commit]]
  it("releases PENDING after a failed commit so new readers and writers can proceed", () => {
    const db = track(openIndexDb(path));
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0; CREATE TABLE entries (id INTEGER)");
    const reader = track(new DatabaseSync(path));
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM entries").all();
    assert.throws(() => withTransaction(db, () => {
      db.exec("INSERT INTO entries VALUES (1)");
    }), /database is locked/);
    const other = track(new DatabaseSync(path));
    other.exec("PRAGMA busy_timeout = 0");
    assert.equal(other.prepare("SELECT COUNT(*) AS n FROM entries").get()!.n, 0);
    reader.exec("ROLLBACK");
    withTransaction(other, () => other.exec("INSERT INTO entries VALUES (2)"));
    withTransaction(db, () => db.exec("INSERT INTO entries VALUES (3)"));
  });

  // @lat: [[sqlite-tests#Pruebas de SQLite#Reserva fallida]]
  it("does not run the callback when the writer reservation fails, and can retry", () => {
    const writer = track(openIndexDb(path));
    writer.exec("CREATE TABLE entries (id INTEGER); BEGIN IMMEDIATE; INSERT INTO entries VALUES (1)");
    const waiter = track(openIndexDb(path));
    waiter.exec("PRAGMA busy_timeout = 0");
    let called = false;
    assert.throws(() => withTransaction(waiter, () => {
      called = true;
      waiter.exec("INSERT INTO entries VALUES (2)");
    }), /database is locked/);
    assert.equal(called, false);
    writer.exec("COMMIT");
    withTransaction(waiter, () => waiter.exec("INSERT INTO entries VALUES (3)"));
    assert.equal(waiter.prepare("SELECT COUNT(*) AS n FROM entries").get()!.n, 2);
  });

  // @lat: [[sqlite-tests#Pruebas de SQLite#Escritores concurrentes]]
  it("waits for a competing writer before FTS delete/insert instead of failing immediately", { timeout: 10000 }, async (t) => {
    const seed = track(openIndexDb(path));
    seed.exec("CREATE VIRTUAL TABLE s USING fts5(id UNINDEXED, content)");
    seed.exec("INSERT INTO s VALUES ('session', 'old')");
    // A newly opened index has not prepared its first FTS statement yet.
    const db = track(openIndexDb(path));
    db.exec("PRAGMA busy_timeout = 2000");
    const writer = new Worker(`
      const { DatabaseSync } = require('node:sqlite');
      const { parentPort, workerData } = require('node:worker_threads');
      const db = new DatabaseSync(workerData);
      db.exec("BEGIN IMMEDIATE; INSERT INTO s VALUES ('other', 'concurrent')");
      parentPort.once('message', () => {
        setTimeout(() => {
          db.exec('COMMIT');
          db.close();
          parentPort.close();
        }, 100);
      });
      parentPort.postMessage('locked');
    `, { eval: true, workerData: path });
    t.after(async () => { await writer.terminate(); });
    await once(writer, "message");
    writer.postMessage("release");
    withTransaction(db, () => {
      db.prepare("DELETE FROM s WHERE id = ?").run("session");
      db.prepare("INSERT INTO s VALUES (?, ?)").run("session", "updated");
    });
    assert.equal(db.prepare("SELECT content FROM s WHERE id = 'session'").get()!.content, "updated");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM s").get()!.n, 2);
    await once(writer, "exit");
  });
});

/**
 * Local database adapter for the Node dev server and the test suite.
 *
 * Uses Node's built-in SQLite (`node:sqlite`) so local development needs no
 * Turso credentials and no native modules — and it exercises the exact same
 * SQL as production. Never imported from the Worker entry point.
 *
 * @typedef {import('./turso.js').Db} Db
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * @param {string} [filename] path to a SQLite file, or ':memory:'
 * @returns {Db}
 */
export function createNodeDb(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  const prepare = (sql) => db.prepare(sql);

  return {
    async all(sql, params = []) {
      return prepare(sql).all(...normalize(params));
    },
    async get(sql, params = []) {
      const row = prepare(sql).get(...normalize(params));
      return row === undefined ? null : row;
    },
    async run(sql, params = []) {
      const result = prepare(sql).run(...normalize(params));
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid:
          result.lastInsertRowid === undefined || result.lastInsertRowid === null
            ? null
            : Number(result.lastInsertRowid),
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const statement of statements) {
          prepare(statement.sql).run(...normalize(statement.params || []));
        }
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}

function normalize(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
      return value;
    }
    if (value instanceof Uint8Array) return value;
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
    return String(value);
  });
}

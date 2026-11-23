// A real D1 stand-in: node:sqlite running the project's own migrations, so
// tests hit the actual schema and SQL instead of a mock guessing at it.
// db.changes counts rows written, which is what D1 bills. db.queries counts
// D1 queries (a batch is one), which the per-invocation cap counts.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export const makeDb = () => {
  const sqlite = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'))
  }
  const db = { sqlite, changes: 0, queries: 0 }
  const wrap = (stmt, params) => ({
    bind: (...p) => wrap(stmt, p),
    _run: () => { const r = stmt.run(...params); db.changes += Number(r.changes); return r },
    run: async function () { db.queries++; return { meta: { changes: this._run().changes } } },
    all: async () => { db.queries++; return { results: stmt.all(...params) } },
    first: async () => { db.queries++; return stmt.get(...params) ?? null }
  })
  db.prepare = (sql) => wrap(sqlite.prepare(sql), [])
  db.batch = async (stmts) => {
    db.queries++
    sqlite.exec('BEGIN')
    try { for (const s of stmts) s._run(); sqlite.exec('COMMIT') } catch (e) { sqlite.exec('ROLLBACK'); throw e }
  }
  return db
}

export const rows = (db, sql, ...p) => db.sqlite.prepare(sql).all(...p)

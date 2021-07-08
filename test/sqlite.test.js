/* eslint-env jest */
import sqlite3 from 'sqlite3'

let db

describe('Test sqlite3', () => {
  test('that sql connects', () => {
    db = new sqlite3.Database('./sdb.sqlite3')
  })
  test('that we can create a table', () => {
    db.run(`
      CREATE TABLE IF NOT EXISTS ostate (
        name TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        time DATETIME DEFAULT CURRENT_TIMESTAMP);`, (err, data) => {
      expect(err).toBeNull()
      db.run('INSERT OR REPLACE INTO ostate (name, value) VALUES (?, ?);', ['foo', JSON.stringify({ bar: 'foo' })], (err, data) => {
        expect(err).toBeNull()
        db.get('SELECT * FROM ostate WHERE name = ?;', ['foo'], (err, res) => {
          expect(err).toBeNull()
          expect(res).toBeDefined()
          expect(res.name).toBeDefined()
          expect(res.value).toBeDefined()
          const o = JSON.parse(res.value)
          expect(o).toBeDefined()
          expect(o.bar).toBeDefined()
          expect(o.bar).toBe('foo')
          db.close(err => expect(err).toBeNull())
        })
      })
    })
  })
})

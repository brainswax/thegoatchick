/* eslint-env jest */
import sqlite3 from 'sqlite3'

let db

describe('Test sqlite3', () => {
  it('should pass', async () => {})
  test('that sql connects', () => {
    const file = './sdb.sqlite3'
    db = new sqlite3.Database(file, (err) => {
      expect(err).toBeNull()
    })
  })
  test('that we can create a table', async () => {
    return db.run(`
      CREATE TABLE IF NOT EXISTS ostate (
        name TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        time DATETIME DEFAULT CURRENT_TIMESTAMP)`)
  })
  test('that we can insert into the table', async () => {
    return db.run('INSERT OR REPLACE INTO ostate (name, value) VALUES (?, ?)', ['foo', JSON.stringify({ bar: 'foo' })])
  })
  test('that we can get the object from the table', async () => {
    return db.get('SELECT * FROM ostate WHERE name = ?', ['foo'], (err, res) => {
      expect(err).toBeNull()
      expect(res).toBeDefined()
      expect(res.name).toBeDefined()
      expect(res.value).toBeDefined()
      expect(JSON.parse(res.value).bar).toBeDefined()
      expect(JSON.parse(res.value).bar).toBe('foo')
    })
  })
  it('should close the database', () => {
    db.close(err => {
      expect(err).toBeNull()
    })
  })
})

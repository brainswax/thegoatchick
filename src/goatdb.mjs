import sqlite3 from 'sqlite3'
import Promise from 'bluebird'

async function run (that, sql, params = []) {
  return new Promise((resolve, reject) => {
    that.db.run(sql, params, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

async function get (that, sql, params = []) {
  return new Promise((resolve, reject) => {
    that.db.get(sql, params, (err, data) => {
      if (err) reject(err)
      else resolve(data ? JSON.parse(data.value) : null)
    })
  })
}

class GoatDB {
  constructor (opts = {}) {
    this.logger = opts.logger || console
    this.initialized = false

    const file = opts.file || './goatdb.sqlite3'
    this.db = opts.db || new sqlite3.Database(file, (err) => {
      if (err) this.logger.warn(`Could not connect to database '${file}'`)
    })
  }

  async init () {
    if (!this.initialized) {
      this.initialized = true
      return run(this, `
        CREATE TABLE IF NOT EXISTS ostate (
          name TEXT PRIMARY KEY,
          value BLOB NOT NULL,
          time DATETIME DEFAULT CURRENT_TIMESTAMP)`)
    }

    return new Promise(() => {})
  }

  async store (name, object) {
    return run(this, 'INSERT OR REPLACE INTO ostate (name, value) VALUES (?, ?)', [name, JSON.stringify(object)])
  }

  async fetch (name) {
    return get(this, 'SELECT * FROM ostate WHERE name = ?', [name])
  }

  async close () {
    return this.db.close()
  }
}

export { GoatDB }

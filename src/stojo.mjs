import { DatabaseSync } from 'node:sqlite'

/**
 * Small key/value store with the same table layout as @codegrill/stojo,
 * backed by Node's built-in SQLite so the app does not need the native sqlite3 addon.
 */
class Stojo {
  constructor (opts = {}) {
    this.logger = opts.logger || console
    this.initialized = false

    const file = opts.file || './stojo.sqlite3'
    try {
      this.db = opts.db || new DatabaseSync(file)
    } catch (err) {
      this.logger.warn(`Could not connect to database '${file}': ${err.message}`)
      throw err
    }

    this.table = opts.table || `
      CREATE TABLE IF NOT EXISTS stojo (
        name TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        time DATETIME DEFAULT CURRENT_TIMESTAMP)`
    this.insert = opts.insert || 'INSERT OR REPLACE INTO stojo (name, value) VALUES (?, ?)'
    this.select = opts.select || 'SELECT * FROM stojo WHERE name = ?'
  }

  async init () {
    if (!this.initialized) {
      this.initialized = true
      this.db.exec(this.table)
    }
  }

  async store (name, object) {
    await this.init()
    this.db.prepare(this.insert).run(name, JSON.stringify(object))
  }

  async fetch (name) {
    await this.init()
    const data = this.db.prepare(this.select).get(name)
    if (!data || data.value == null) return null
    const raw = typeof data.value === 'string' ? data.value : Buffer.from(data.value).toString('utf8')
    return JSON.parse(raw)
  }

  close () {
    this.db.close()
  }
}

export { Stojo }

import sqlite3 from 'sqlite3'
import Promise from 'bluebird'

/**
A database run command wrapped in a Promise.
@param that an instance of GoatDB
@param sql the SQL statement to perform
@param params any paramaterized variables to replace in the statement
@return a promise to perform the statement and return the result as an object
*/
async function run (that, sql, params = []) {
  return new Promise((resolve, reject) => {
    that.db.run(sql, params, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

/**
A database get command wrapped in a Promise.
@param that an instance of GoatDB
@param sql the SQL query to perform
@param params any paramaterized variables to replace in the query
@return a promise to perform the query and return the result as an object
*/
async function get (that, sql, params = []) {
  return new Promise((resolve, reject) => {
    that.db.get(sql, params, (err, data) => {
      if (err) reject(err)
      else resolve(data ? JSON.parse(data.value) : null)
    })
  })
}

/**
This class is meant to be used to store the state of objects across a restart.

It is a basic key:value (name:object) object store, which uses sqlite3 by default.
You can store an arbitrary JavaScript object by speficying a name and the object.
The named Object can then be retrieved later with a fetch.
*/
class GoatStore {
  constructor (opts = {}) {
    this.logger = opts.logger || console
    this.initialized = false

    const file = opts.file || './goatdb.sqlite3'
    this.db = opts.db || new sqlite3.Database(file, (err) => {
      if (err) this.logger.warn(`Could not connect to database '${file}'`)
    })

    this.table = opts.table || `
      CREATE TABLE IF NOT EXISTS ostate (
        name TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        time DATETIME DEFAULT CURRENT_TIMESTAMP)`
  }

  /**
  Ensure that the table is created for the database. This is meant to be called on every operation
  so the user of this class doesn't have to care about when to create the database table.
  @return a promise to create the database table
  */
  async init () {
    if (!this.initialized) {
      this.initialized = true
      return run(this, this.table)
    }
  }

  /**
  Stores a named object in the database
  @param name a unique name to identify the object in the database
  @param object the object being persisted
  @return a promise to store the object
  */
  async store (name, object) {
    return this.init().then(() => run(this, 'INSERT OR REPLACE INTO ostate (name, value) VALUES (?, ?)', [name, JSON.stringify(object)]))
  }

  /**
  Fetch a named object from the database
  @param name a unique name to identify the object in the database
  @return a promise to retrieve it as an object
  */
  async fetch (name) {
    return this.init().then(() => get(this, 'SELECT * FROM ostate WHERE name = ?', [name]))
  }

  /**
  Close the database connection
  @return a promise to close the database connection
  */
  async close () {
    return this.db.close()
  }
}

export { GoatStore }

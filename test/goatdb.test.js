/* eslint-env jest */
import * as goatdb from '../src/goatdb.mjs'
import fs from 'fs'

describe('Test GoatDB functionality', () => {
  const file = './goatdb.sqlite3'
  if (fs.existsSync(file)) fs.unlinkSync(file)

  const db = new goatdb.GoatDB({ file: file })

  it('can store and retrieve an object', async () => {
    return db.init()
      .then(() => db.store('test.foo', { foo: 'foo' }))
      .then(() => db.fetch('test.foo'))
      .then((data) => {
        expect(data).toBeDefined()
        expect(data.foo).toBeDefined()
        expect(data.foo).toBe('foo')
      })
      .then(() => db.close())
  })
})

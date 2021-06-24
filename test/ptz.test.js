/* eslint-env jest */
import * as cenv from 'custom-env'

cenv.env(process.env.NODE_ENV)

describe('Test PTZ camera functionality', () => {
  it('Ensure required environment variables exist', () => {
    expect(process.env.PTZ_CONFIG).toBeDefined()
  })
})

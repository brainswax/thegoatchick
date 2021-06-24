/* eslint-env jest */
import * as cenv from 'custom-env'

cenv.env(process.env.NODE_ENV)

describe('Test OBS view functionality', () => {
  it('Ensure required environment variables exist', () => {
    expect(process.env.OBS_ADDRESS).toBeDefined()
    expect(process.env.OBS_PASSWORD).toBeDefined()
  })
})

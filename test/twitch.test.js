/* eslint-env jest */
import * as cenv from 'custom-env'

cenv.env(process.env.NODE_ENV)

describe('Test twitch functionality', () => {
  it('Ensure required environment variables exist', () => {
    expect(process.env.TWITCH_CHANNEL).toBeDefined()
    expect(process.env.TWITCH_USER).toBeDefined()
    expect(process.env.TWITCH_TOKEN).toBeDefined()
  })
})

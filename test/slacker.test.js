/* eslint-env jest */
import * as cenv from 'custom-env'
import { logger } from '../src/slacker.mjs'

cenv.env(process.env.NODE_ENV)

describe('Test twitch functionality', () => {
  it('Ensure required environment variables exist', () => {
    expect(process.env.SLACK_HOOK).toBeDefined()
    expect(process.env.SLACK_HOOK).not.toBe('')
  })

  if (process.env.GO_LIVE && process.env.GO_LIVE === 'true') {
    it('Test a basic info message', async () => {
      return logger.info('Test: info message')
        .then(() => logger.warn('Test: warn message'))
        .then(() => logger.debug('Test: debug message'))
        .then(() => logger.error('Test: error message'))
    })
  }
})

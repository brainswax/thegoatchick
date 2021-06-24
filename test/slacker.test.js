/* eslint-env jest */
import * as cenv from 'custom-env'
import { logger } from '../src/slacker.mjs'

cenv.env(process.env.NODE_ENV)

const goLive = process.env.GO_LIVE && process.env.GO_LIVE === 'true'

describe('Test twitch functionality', () => {
  it('Ensure required environment variables exist', () => {
    if (goLive) {
      expect(process.env.SLACK_HOOK).toBeDefined()
      expect(process.env.SLACK_HOOK).not.toBe('')
    } else if (process.env.SLACK_HOOK) {
      expect(process.env.SLACK_HOOK).toBe('')
    }
  })

  if (goLive) {
    it('Test a basic info message', async () => {
      return logger.info('Test: info message')
        .then(() => logger.warn('Test: warn message'))
        .then(() => logger.debug('Test: debug message'))
        .then(() => logger.error('Test: error message'))
    })
  }
})

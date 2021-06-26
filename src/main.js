#!/usr/bin/env node
import * as cenv from 'custom-env'
import { logger } from './slacker.mjs'

// Load the environment variables for the current environmant
cenv.env(process.env.NODE_ENV)
const app = {}
app.exited = false

;(async () => {
  // ///////////////////////////////////////////////////////////////////////////
  // Setup general application behavior and logging
  process.on('beforeExit', (code) => {
    if (!app.exited) {
      app.exited = true
      logger.info(`== about to exit with code: ${code}`)
    }
  })
  process.on('exit', (code) => { console.info(`== exited with code: ${code}`) })

  import('../package.json')
    .then(pkg => { logger.info(`== starting ${pkg.default.name}@${pkg.default.version}`) })
    .catch(e => { logger.error(`Unable to open package information: ${e}`) })
})()

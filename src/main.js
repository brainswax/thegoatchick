#!/usr/bin/env node
import * as cenv from 'custom-env'

// Load the environment variables for the current environmant
cenv.env(process.env.NODE_ENV);

(async () => {
  console.info('Hello world!')
})()

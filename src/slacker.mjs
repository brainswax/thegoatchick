import axios from 'axios'

/* Slacker

   This is a basic logger module that can be used to send various log messages
   to slack and to the local console. It relies on the SLACK_HOOK environment
   variable to proivude the URL to post the message to.

   All messages will also be printed to stderr/stdout via the console.

   The slack URL itself can be generated by creating an application and an
   associated Incoming Webhook.

*/

// Format a message as an error to be sent to slack
function formatError (error) {
  return {
    mkdwn: true,
    attachments: [{
      title: 'Error',
      color: '#f50057',
      text: `[${new Date().toISOString()}] ${error}`
    }]
  }
}

// Format a message as an error to be sent to slack
function formatWarn (log) {
  return {
    mkdwn: true,
    attachments: [{
      title: 'Warning',
      color: '#ffdd33',
      text: `[${new Date().toISOString()}] ${log}`
    }]
  }
}

// Format a message as a normal log to be sent to slack
function formatInfo (log) {
  return {
    mkdwn: true,
    attachments: [{
      color: 'good',
      text: `[${new Date().toISOString()}] ${log}`
    }]
  }
};

// Format a debug message to be sent to slack
function formatDebug (log) {
  return {
    mkdwn: true,
    attachments: [{
      title: 'Debug',
      color: '#BBBBBB',
      text: `[${new Date().toISOString()}] ${log}`
    }]
  }
};

// Send a message to slack
async function notify (msg) {
  if (typeof (msg) !== 'undefined' && process.env.SLACK_HOOK && process.env.SLACK_LOG === 'true') {
    return axios.post(process.env.SLACK_HOOK, msg)
      .catch(err => console.error(`Error: slacker.notify unable to log message: ${msg}: ${err}`))
  }
}

/// ////////////////////////////////////////////////////////////////////////////
// Exported logging functionality

const logger = { }
Object.defineProperties(logger, {
  EMERGENCY: { value: 0, writeable: false, enumerable: true },
  ALERT: { value: 1, writeable: false, enumerable: true },
  CRITICAL: { value: 2, writeable: false, enumerable: true },
  ERROR: { value: 3, writeable: false, enumerable: true },
  WARN: { value: 4, writeable: false, enumerable: true },
  NOTICE: { value: 5, writeable: false, enumerable: true },
  INFO: { value: 6, writeable: false, enumerable: true },
  DEBUG: { value: 7, writeable: false, enumerable: true },
  level: { value: {}, writeable: false, enumerable: false }
})
logger.level.console = logger.DEBUG
logger.level.slack = logger.ERROR

logger.getLogLevel = (value) => {
  let level = 'DEBUG'

  for (const l in logger) {
    if (logger[l] === value) level = l
  }

  return level
}

// This will generate logs despite the log level settings
logger.log = async log => {
  console.log(`[${new Date().toISOString()}] Info:  ${log}`)
  return notify(formatInfo(log))
}

// Send an error message to slack
logger.error = async log => {
  if (logger.level.console >= logger.ERROR) {
    console.error(`[${new Date().toISOString()}] Error: ${log}`)
  }
  return logger.level.slack >= logger.ERROR ? notify(formatError(log)) : true
}

// Send a warning message to slack
logger.warn = async log => {
  if (logger.level.console >= logger.WARN) {
    console.warn(`[${new Date().toISOString()}] Warn:  ${log}`)
  }
  return logger.level.slack >= logger.WARN ? notify(formatWarn(log)) : true
}

// Send an information message to slack
logger.info = async log => {
  if (logger.level.console >= logger.INFO) {
    console.info(`[${new Date().toISOString()}] Info:  ${log}`)
  }
  return logger.level.slack >= logger.INFO ? notify(formatInfo(log)) : true
}

// Send an debug message to slack
logger.debug = async log => {
  if (logger.level.console >= logger.DEBUG) {
    console.debug(`[${new Date().toISOString()}] Debug: ${log}`)
  }
  return logger.level.slack >= logger.DEBUG ? notify(formatDebug(log)) : true
}

export { logger }

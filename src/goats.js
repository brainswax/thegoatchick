import tmi from 'tmi.js'
import OBSWebSocket from 'obs-websocket-js'
import OBSView from './obs-view.js'
import PTZ from './ptz.js'
import { GoatStore } from './goatstore.mjs'
import { logger } from './slacker.mjs'
import * as cenv from 'custom-env'

cenv.env(process.env.NODE_ENV)
const twitchChannel = process.env.TWITCH_CHANNEL
const prettySpace = '    ' // Used for formatting JSON in logs
const app = {}
app.exited = false

// Set default config file locations
if (!process.env.PTZ_CONFIG || process.env.PTZ_CONFIG === '') { process.env.PTZ_CONFIG = '../conf/ptz.json' }
if (!process.env.OBS_VIEWS_CONFIG || process.env.OBS_VIEWS_CONFIG === '') { process.env.OBS_VIEWS_CONFIG = '../conf/obs-views.json' }
if (!process.env.DB_FILE || process.env.DB_FILE === '') { process.env.DB_FILE = './goatdb.sqlite3' }

// Grab log levels to console and slack
logger.level.console = logger[process.env.LOG_LEVEL_CONSOLE] || logger.level.console
logger.level.slack = logger[process.env.LOG_LEVEL_SLACK] || logger.level.slack

/**
Get the PTZ config and connect to the cameras
@param configFile the name of the JSON config file with the camera options
@return a promise to a Map of camera names to instances
*/
function getPTZCams (configFile, options = []) {
  return import(configFile)
    .then(conf => {
      const c = new Map()
      // This assumes that the camera options are under the "cams" entry in the JSON file
      for (const [key, value] of Object.entries(conf.default.cams)) {
        value.name = key
        Object.assign(value, options)
        c.set(key, new PTZ(value))
      }

      return c
    })
    .catch(e => { logger.error(`Unable to import '${configFile}': ${e}`) })
}

;(async () => {
  // ///////////////////////////////////////////////////////////////////////////
  // Setup general application behavior and logging
  process.on('beforeExit', (code) => {
    if (!app.exited) {
      app.exited = true
      logger.info(`== about to exit with code: ${code}`)
      db.close()
    }
  })
  process.on('uncaughtException', (err, origin) => {
    logger.error(`${origin}: ${err}`)
  })
  process.on('unhandledRejection', (reason, promise) => {
    logger.warn(`Venice broke her promise to Jerry...\nPromise: ${promise.constructor.valueOf()}\nReason: ${JSON.stringify(reason, null, prettySpace)}`)
  })
  process.on('exit', (code) => { logger.log(`== exiting with code: ${code}`) })

  // Grab the version and log it
  import('../package.json')
    .then(pkg => { logger.log(`== starting ${pkg.default.name}@${pkg.default.version}`) })
    .catch(e => { logger.error(`Unable to open package information: ${e}`) })

  // Always show log levels at startup
  logger.log(`== log levels: { console: ${logger.getLogLevel(logger.level.console)}, slack: ${logger.getLogLevel(logger.level.slack)} }`)

  // Open and initialize the sqlite database for storing object states across restarts
  const db = new GoatStore({ logger: logger, file: process.env.DB_FILE })

  // ///////////////////////////////////////////////////////////////////////////
  // Connect to OBS
  const obs = new OBSWebSocket()
  const obsView = new OBSView({
    config: process.env.OBS_VIEWS_CONFIG,
    obs: obs,
    db: db,
    logger: logger
  })

  // Connect to OBS
  obs.connect({ address: process.env.OBS_ADDRESS, password: process.env.OBS_PASSWORD })
    .then(() => {
      logger.info('== connected to OBS')
      obsView.updateOBS()
    })
    .catch(err => logger.error(`OBS connection failed: ${err.code}: ${err.error}`))

  // ///////////////////////////////////////////////////////////////////////////
  // Load the PTZ cameras
  const cams = await getPTZCams(process.env.PTZ_CONFIG, { logger: logger, db: db })
    .then((cams) => { logger.info('== loaded cameras'); return cams })
    .catch(err => logger.error(`== loading cameras: ${err}`))

  // ///////////////////////////////////////////////////////////////////////////
  // Connect to twitch
  const chat = new tmi.Client({
    identity: {
      username: process.env.TWITCH_USER,
      password: process.env.TWITCH_TOKEN
    },
    connection: { reconnect: process.env.TWITCH_RECONNECT !== 'false' },
    maxReconnectAttempts: process.env.TWITCH_RECONNECT_TRIES,
    channels: [twitchChannel]
  })

  chat.on('cheer', onCheerHandler)
  chat.on('chat', onChatHandler)
  chat.on('connected', onConnectedHandler)
  chat.on('disconnected', onDisconnectedHandler)
  chat.on('reconnect', () => { logger.info('== reconnecting to twitch') })

  // Connect to Twitch:
  chat.connect()
    .then(() => logger.info(`== connected to twitch channel: ${process.env.TWITCH_USER}@${twitchChannel}`))
    .catch(err => logger.error(`Unable to connect to twitch: ${JSON.stringify(err, null, prettySpace)}`))

  function onCheerHandler (target, context, msg) {
    logger.log(`Cheer: ${JSON.stringify({ target: target, msg: msg, context: context }, null, prettySpace)}`)

    // Automatically show the treat camera if it's not already shown
    if (!obsView.inView('treat')) {
      obsView.processChat('1treat')
    }
    cams.get('treat').moveToShortcut('cheer')

    // Process this last to ensure the auto-treat doesn
    obsView.processChat(msg)
  }

  function onChatHandler (target, context, msg) {
    if (context['display-name'] === 'HerdBoss') return // ignore the bot

    chatBot(msg, context)
  }
  // Called every time the bot connects to Twitch chat:
  function onConnectedHandler (addr, port) {
    logger.log(`== connected to twitch server: ${addr}:${port}`)
  }

  // Called every time the bot disconnects from Twitch:
  // TODO: reconnect rather than exit
  function onDisconnectedHandler (reason) {
    logger.info(`== disconnected from twitch: ${reason || 'unknown reason'}`)
  }

  function sayForSubs () {
    chat.say(twitchChannel, 'This command is reserved for Subscribers')
  }

  function chatBot (str, context) {
    // Only process the command if the message starts with a '!'
    if (!str.trim().startsWith('!')) return

    logger.debug(`\nmessage: ${str}\nuser: ${JSON.stringify(context, null, prettySpace)}`)

    const matches = str.trim().toLowerCase().match(/!(\w+)\b/gm)
    if (matches == null || obsView.cameraTimeout(context.username)) return

    matches.forEach(match => {
      switch (match) {
        // SUBSCRIBER COMMANDS
        case '!cam':
        case '!camera':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          obsView.processChat(str)
          return
        case '!treat':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          if (cams.has('treat')) cams.get('treat').command(str)
          return
        case '!does':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          if (cams.has('does')) cams.get('does').command(str)
          return
        case '!yard':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          if (cams.has('yard')) cams.get('yard').command(str)
          return
        case '!kids':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          if (cams.has('kids')) cams.get('kids').command(str)
          return
        case '!pasture':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          if (cams.has('pasture')) cams.get('pasture').command(str)
          return
        case '!bell':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) return

          // Automatically show the does camera if it's not already shown
          if (!obsView.inView('does')) {
            obsView.processChat('2does')
          }
          if (cams.has('does')) cams.get('does').moveToShortcut('bell')
          return

        // MOD COMMANDS
        case '!log': {
          if (context.mod || (context.badges && context.badges.broadcaster)) {
            const words = str.trim()
              .replace(/[a-z][\s]+[+:-]/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces before a colon
              .replace(/[a-z][+:-][\s]+/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces after a colon
              .split(/[\s]+/) // split on whitespace

            words.forEach((word) => {
              if (word.search(':') > 0) {
                const [dest, level] = word.split(/[:]/)
                logger.updateLog(dest, level)
              }
            })
          }
          return
        }
        case '!mute':
          if (context.mod || (context.badges && context.badges.broadcaster)) {
            obs.send('SetMute', { source: 'Audio', mute: true })
          }
          return
        case '!unmute':
          if (context.mod || (context.badges && context.badges.broadcaster)) {
            obs.send('SetMute', { source: 'Audio', mute: false })
          }
          return
        case '!stop':
          if (context.mod || (context.badges && context.badges.broadcaster)) {
            chat.say(twitchChannel, 'Stopping')
            obs.send('StopStreaming')
          }
          return
        case '!start':
          if (context.mod || (context.badges && context.badges.broadcaster)) {
            chat.say(twitchChannel, 'Starting')
            obs.send('StartStreaming')
          }
          return
        case '!restart':
          if (context.mod || (context.badges && context.badges.broadcaster)) {
            chat.say(twitchChannel, 'Stopping')
            obs.send('StopStreaming')
            setTimeout(function () { chat.say(twitchChannel, ':Z Five') }, 5000)
            setTimeout(function () { chat.say(twitchChannel, ':\\ Four') }, 6000)
            setTimeout(function () { chat.say(twitchChannel, ';p Three') }, 7000)
            setTimeout(function () { chat.say(twitchChannel, ':) Two') }, 8000)
            setTimeout(function () { chat.say(twitchChannel, ':D One') }, 9000)
            setTimeout(function () {
              chat.say(twitchChannel, 'Starting')
              obs.send('StartStreaming')
            }, 10000)
          }
      }
    })
  }
})()
  .catch(err => logger.error(`Application error: ${err}`))

import tmi from 'tmi.js'
import OBSWebSocket from 'obs-websocket-js'
import OBSView from './obs-view.js'
import PTZ from './ptz.js'
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

// Grab log levels to console and slack
logger.level.console = logger[process.env.LOG_LEVEL_CONSOLE] || logger.level.console
logger.level.slack = logger[process.env.LOG_LEVEL_SLACK] || logger.level.slack

/**
Get the PTZ config and connect to the cameras
@param configFile the name of the JSON config file with the camera options
@return a promise to a Map of camera names to instances
*/
function getPTZCams (configFile) {
  return import(configFile)
    .then(conf => {
      const c = new Map()
      // This assumes that the camera options are under the "cams" entry in the JSON file
      for (const [key, value] of Object.entries(conf.default.cams)) {
        value.name = key
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
    if (!app.exited) { app.exited = true; logger.info(`== about to exit with code: ${code}`) }
  })
  process.on('uncaughtException', (err, origin) => {
    logger.error(`${origin}: ${err}`)
  })
  process.on('unhandledRejection', (reason, promise) => {
    logger.warn(`Venice broke her promise to Jerry...\nPromise: ${promise.constructor.valueOf()}\nReason: ${JSON.stringify(reason, null, prettySpace)}`)
  })
  process.on('exit', (code) => { logger.log(`== exiting with code: ${code}`) })

  import('../package.json')
    .then(pkg => { logger.log(`== starting ${pkg.default.name}@${pkg.default.version}`) })
    .catch(e => { logger.error(`Unable to open package information: ${e}`) })

  // ///////////////////////////////////////////////////////////////////////////
  // Connect to OBS
  const obs = new OBSWebSocket()

  // Connect to OBS
  obs.connect({ address: process.env.OBS_ADDRESS, password: process.env.OBS_PASSWORD })
    .then(() => logger.info('== connected to OBS'))
    .catch(err => {
      logger.error(`OBS connection failed: ${JSON.stringify(err, null, prettySpace)}`)
    })

  // Set up OBS window changer
  const obsView = new OBSView({
    config: process.env.OBS_VIEWS_CONFIG,
    obs: obs,
    logger: logger
  })

  // ///////////////////////////////////////////////////////////////////////////
  // Load the PTZ cameras
  const cams = await getPTZCams(process.env.PTZ_CONFIG)
    .then((cams) => { logger.info('== loaded PTZ cameras'); return cams })
    .catch(err => logger.error(`Unable to get PTZ cams: ${err}`))

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
    obsView.processChat(msg)
  }

  function onChatHandler (target, context, msg) {
    if (context['display-name'] === 'HerdBoss') return // ignore the bot
    // logger.debug(`User context: ${JSON.stringify(context, null, prettySpace)}`)
    chatBot(msg, context)
  }
  // Called every time the bot connects to Twitch chat:
  function onConnectedHandler (addr, port) {
    logger.info(`== connected to twitch server: ${addr}:${port}`)
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
    const wordsRegex = /!(\w+)\b/gm

    logger.debug(`\nmessage: ${str}\nuser: ${JSON.stringify(context, null, prettySpace)}`)
    const matches = str.toLowerCase().match(wordsRegex)
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
          cams.get('treat').command(str)
          return
        case '!does':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          cams.get('does').command(str)
          return
        case '!yard':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          cams.get('yard').command(str)
          return
        case '!kids':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          cams.get('kids').command(str)
          return
        case '!pasture':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) {
            sayForSubs()
            return
          }
          cams.get('pasture').command(str)
          return

        // MOD COMMANDS
        case '!mute':
          if (context.mod) {
            obs.send('SetMute', { source: 'Audio', mute: true })
          }
          return
        case '!unmute':
          if (context.mod) {
            obs.send('SetMute', { source: 'Audio', mute: false })
          }
          return
        case '!stop':
          if (context.mod) {
            chat.say(twitchChannel, 'Stopping')
            obs.send('StopStreaming')
          }
          return
        case '!start':
          if (context.mod) {
            chat.say(twitchChannel, 'Starting')
            obs.send('StartStreaming')
          }
          return
        case '!restart':
          if (context.mod) {
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

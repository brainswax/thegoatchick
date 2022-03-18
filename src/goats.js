import tmi from 'tmi.js'
import OBSWebSocket from 'obs-websocket-js'
import OBSView from './obs-view.js'
import PTZ from './ptz.js'
import { triggerRestart } from './autostart.mjs'
import { Stojo } from '@codegrill/stojo'
import { logger } from './slacker.mjs'
import * as cenv from 'custom-env'

cenv.env(process.env.NODE_ENV)
const twitchChannel = process.env.TWITCH_CHANNEL
const prettySpace = '    ' // Used for formatting JSON in logs
const app = {}
app.exited = false
app.obs = {}

// Set default config file locations
if (!process.env.PTZ_CONFIG || process.env.PTZ_CONFIG === '') { process.env.PTZ_CONFIG = '../conf/ptz.json' }
if (!process.env.OBS_VIEWS_CONFIG || process.env.OBS_VIEWS_CONFIG === '') { process.env.OBS_VIEWS_CONFIG = '../conf/obs-views.json' }
if (!process.env.DB_FILE || process.env.DB_FILE === '') { process.env.DB_FILE = './goatdb.sqlite3' }
if (!process.env.APP_CONFIG || process.env.APP_CONFIG === '') { process.env.APP_CONFIG = '../conf/goats.json' }

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

class AdminStore {
  constructor (options) {
    this.logger = options.logger || console
    this.db = options.db || new Stojo({ logger: this.logger })
  }

  get key () {
    return 'admins'
  }

  get admins () {
    return this.db.fetch(this.key)
      .then(admins => {
        if (admins) this.logger.info(`loaded the stored admins: ${JSON.stringify(admins)}`)
        return new Set(admins)
      })
      .catch(err => this.logger.warn(`loading the admins: ${err}`))
  }

  set admins (admins) {
    const a = Array.from(admins)
    this.logger.info(`store the admins: ${JSON.stringify(a)}`)
    this.db.store(this.key, a)
      .catch(err => this.logger.warn(`storing the admins: ${err}`))
  }
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
  const db = new Stojo({ logger: logger, file: process.env.DB_FILE })
  const adminStore = new AdminStore({ logger: logger, db: db })
  const admins = await adminStore.admins

  if (admins.size === 0) {
    import(process.env.APP_CONFIG)
      .then(config => {
        logger.debug(`Loading admins: ${JSON.stringify(config)}`)
        if (config && config.default && config.default.admins) {
          config.default.admins.forEach(admin => admins.add(admin))
          adminStore.admins = admins
        }
      })
      .catch(e => logger.warn(`Unable to load admins from ${process.env.APP_CONFIG}: ${e}`))
  }

  // ///////////////////////////////////////////////////////////////////////////
  // Connect to OBS
  const obs = new OBSWebSocket()
  const obsView = new OBSView({
    config: process.env.OBS_VIEWS_CONFIG,
    obs: obs,
    db: db,
    logger: logger
  })

  async function connectObs(obs) {
    return obs.connect({ address: process.env.OBS_ADDRESS, password: process.env.OBS_PASSWORD })
      .then(() => logger.info('== connected to OBS'))
      .then(() => obsView.syncFromObs())
      .then(() => obsView.updateOBS())
  }

  obs.on('ConnectionOpened', () => { logger.info(`== OBS:ConnectionOpened`) })
  obs.on('ConnectionClosed', () => {
    logger.info(`== OBS:ConnectionClosed`)
    // If the connection closes, retry after the timeout period
    if (process.env.OBS_RETRY !== 'false') {
      setTimeout(() => connectObs(obs), process.env.OBS_RETRY_DELAY || 3000)
    }
  })
  obs.on('AuthenticationSuccess', () => { logger.info(`== OBS:AuthenticationSuccess`) })
  obs.on('AuthenticationFailure', (data) => { logger.info(`== OBS:AuthenticationFailure: ${JSON.stringify(data)}`) })
  obs.on('error', err => logger.error(`==OBS: error: ${JSON.stringify(err)}`))

  // Connect to OBS
  connectObs(obs)

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
    logger.info(`Cheer: ${JSON.stringify({ target: target, msg: msg, context: context }, null, prettySpace)}`)

    // Automatically show the 'treat' camera at the 'cheer' shortcut if it's not already shown
    if (!obsView.inView('treat')) obsView.processChat('1treat')
    if (cams.has('treat')) cams.get('treat').moveToShortcut('cheer')

    // Process this last to ensure the auto-treat doesn't override a cheer command
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
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster) && !admins.has(context.username.toLowerCase())) {
            sayForSubs()
            return
          }
          obsView.processChat(str)
          return
        case '!bell':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) return
          logger.debug(`${context.username} is ringing the bell`)

          // Automatically show the 'does' camera at the 'bell' shortcut if it's not already shown
          if (!obsView.inView('does')) obsView.processChat('2does')
          if (cams.has('does')) cams.get('does').moveToShortcut('bell')
          return

        // MOD COMMANDS
        case '!log': {
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
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
        case '!admin':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            const words = str.trim().toLowerCase()
              .replace(/[a-z]+[\s]+[\d]+/g, (s) => { return s.replace(/[\s]+/, '') }) // replace something like '1 treat' with '1treat'
              .replace(/[a-z][\s]+[+:-]/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces before a colon
              .replace(/[a-z][+:-][\s]+/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces after a colon
              .replace(/[!]+[\S]+[\s]+/, '') // remove the !cam at the beginning
              .split(/[\s]+/) // split on whitespace

            words.forEach(cmd => {
              if (cmd.search(/[a-z]+:[\S]+/) >= 0) {
                const [command, value] = cmd.split(/[:]+/)
                switch (command) {
                  case 'add':
                    logger.info(`Adding admin '${value}'`)
                    admins.add(value)
                    break
                  case 'delete':
                  case 'remove':
                    logger.info(`Removing admin '${value}'`)
                    admins.delete(value)
                    break
                }
                adminStore.admins = admins
              }
            })
          }
          return
        case '!mute':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('SetMute', { source: 'Audio', mute: true })
              .then(() => chat.say(twitchChannel, 'Stream muted'))
              .catch(e => {
                logger.error(`Unable to mute: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Unable to mute the stream!')
              })
          }
          return
        case '!unmute':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('SetMute', { source: 'Audio', mute: false })
              .then(() => chat.say(twitchChannel, 'Stream unmuted'))
              .catch(e => {
                logger.error(`Unable to unmute: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Unable to unmute the stream!')
              })
          }
          return
        case '!restartscript':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            triggerRestart(process.env.RESTART_FILE)
              .then(() => logger.info(`Triggered restart and wrote file '${process.env.RESTART_FILE}'`))
              .catch(e => logger.error(`Unable to write the restart file '${process.env.RESTART_FILE}': ${e}`))
          }
          return
        case '!stop':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('StopStreaming')
              .then(() => chat.say(twitchChannel, 'Stream stopped'))
              .catch(e => {
                logger.error(`Unable to stop OBS: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Something went wrong... unable to stop the stream')
              })
          }
          return
        case '!start':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('StartStreaming')
              .then(() => chat.say(twitchChannel, 'Stream started'))
              .catch(e => {
                logger.error(`Unable to start OBS: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Something went wrong... unable to start the stream')
              })
          }
          return
        case '!restart':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('StopStreaming')
              .then(() => {
                chat.say(twitchChannel, 'Stream stopped. Starting in...')
                setTimeout(function () { chat.say(twitchChannel, ':Z Five') }, 5000)
                setTimeout(function () { chat.say(twitchChannel, ':\\ Four') }, 6000)
                setTimeout(function () { chat.say(twitchChannel, ';p Three') }, 7000)
                setTimeout(function () { chat.say(twitchChannel, ':) Two') }, 8000)
                setTimeout(function () { chat.say(twitchChannel, ':D One') }, 9000)
                setTimeout(function () {
                  obs.send('StartStreaming')
                    .then(() => chat.say(twitchChannel, 'Stream restarted'))
                    .catch(e => {
                      logger.error(`Unable to start OBS after a restart: ${JSON.stringify(e, null, prettySpace)}`)
                      chat.say(twitchChannel, 'Something went wrong... unable to restart the stream')
                    })
                }, 10000)
              })
              .catch(e => {
                logger.error(`Unable to stop OBS for a restart: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Something went wrong... the stream won\'t stop.')
              })
          }
          break
        default: {
          const cam = match.replace(/^[!]+/, '')
          if (cams.has(cam)) {
            if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster) && !admins.has(context.username.toLowerCase())) {
              sayForSubs()
              return
            }
            cams.get(cam).command(str)
          }
        }
      }
    })
  }
})()
  .catch(err => logger.error(`Application error: ${err}`))

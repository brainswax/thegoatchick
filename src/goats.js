import tmi from 'tmi.js'
import OBSWebSocket from 'obs-websocket-js'
import OBSView from './obs-view.js'
import PTZ from './ptz.js'
import { triggerRestart } from './autostart.mjs'
import { Stojo } from '@codegrill/stojo'
import { logger } from './slacker.mjs'
import * as cenv from 'custom-env'
import crypto from 'crypto'

cenv.env(process.env.NODE_ENV)
const twitchChannel = process.env.TWITCH_CHANNEL
const prettySpace = '    ' // Used for formatting JSON in logs

// Set default config file locations
if (!process.env.PTZ_CONFIG || process.env.PTZ_CONFIG === '') { process.env.PTZ_CONFIG = '../conf/ptz.json' }
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
async function getPTZCams (map, names, configFile, options = []) {
  return import(configFile)
    .catch(e => { logger.error(`Unable to import '${configFile}': ${e}`) })
    .then(conf => {
      // This assumes that the camera options are under the "cams" entry in the JSON file
      for (const [key, value] of Object.entries(conf.default.cams)) {
        names.push(key.toLocaleLowerCase())
        value.name = key
        Object.assign(value, options)
        map.set(key, new PTZ(value))
      }
    })
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
  const app = {}
  app.exited = false
  app.obs = {}
  app.ptz = {}
  app.ptz.names = []
  app.ptz.cams = new Map()
  app.obs.retries = 0
  app.stream = {}
  app.shutdown = []

  // ///////////////////////////////////////////////////////////////////////////
  // Setup general application behavior and logging
  async function shutdown () {
    await Promise.all(app.shutdown.map(async f => {
      try { await f() } catch { logger.error('Error shutting something down!') }
    }))
    setTimeout(() => process.exit(1), 0) // push it back on the event loop
  }

  process.on('SIGTERM', () => {
    console.log('\nSIGTERM received.')
    shutdown()
  })
  process.on('SIGINT', () => {
    console.log('\nSIGINT received.')
    shutdown()
  })
  process.on('SIGBREAK', () => {
    console.log('\nSIGBREAK received.')
    shutdown()
  })
  process.on('beforeExit', (code) => {
    if (!app.exited) {
      app.exited = true
      logger.info(`== about to exit with code: ${code}`)
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
  app.shutdown.push(() => {
    logger.info('== Shutting down the local database...')
    db.close()
  })
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
  app.shutdown.push(async () => {
    logger.info('== Shutting down OBS...')
    obs.disconnect()
  })
  const obsView = new OBSView({
    obs: obs,
    db: db,
    logger: logger
  })

  async function connectObs (obs) {
    logger.info(`== connecting to OBS host:${process.env.OBS_ADDRESS}, hash: ${crypto.createHash('sha256').update(process.env.OBS_PASSWORD).digest('base64')}`)
    return obs.connect({ address: process.env.OBS_ADDRESS, password: process.env.OBS_PASSWORD })
      .then(() => {
        app.obs.retries = 0 // Reset for the next disconnect
        logger.info('== connected to OBS')
      })
      .then(() => obsView.syncFromObs())
  }

  obs.on('ConnectionOpened', () => {
    logger.info('== OBS connection opened')
  })
  obs.on('ConnectionClosed', () => {
    logger.info('== OBS connection closed')
    // If the connection closes, retry after the timeout period
    if (process.env.OBS_RETRY !== 'false') {
      const delay = Math.round((process.env.OBS_RETRY_DELAY || 3000) * ((process.env.OBS_RETRY_DECAY || 1.2) ** app.obs.retries++))
      logger.info(`OBS reconnect delay: ${delay / 1000} seconds, retries: ${app.obs.retries}`)
      setTimeout(() => {
        connectObs(obs)
          .then(() => obs.send('GetVideoInfo'))
          .then((info) => {
            // Need the info to get the stream resolution
            app.stream.info = info
            logger.info(`Stream Base Resolution: ${app.stream.info.baseWidth}x${app.stream.info.baseHeight}, Output Resolution: ${app.stream.info.outputWidth}x${app.stream.info.outputHeight}`)
            logger.debug(`Video Info: ${JSON.stringify(info, null, 2)}`)
          })
          .catch(e => logger.error(`Connect OBS retry failed: ${e.error}`))
      }, delay)
    }
  })
  obs.on('AuthenticationSuccess', () => { logger.info('== OBS successfully authenticated') })
  obs.on('AuthenticationFailure', () => { logger.info('== OBS failed authentication') })
  obs.on('error', err => logger.error(`== OBS error: ${JSON.stringify(err)}`))

  // Connect to OBS
  connectObs(obs)
    .catch(e => logger.error(`Connect OBS failed: ${e.error}`))

  // ///////////////////////////////////////////////////////////////////////////
  // Load the PTZ cameras
  await getPTZCams(app.ptz.cams, app.ptz.names, process.env.PTZ_CONFIG, { logger: logger, db: db })
    .then(() => logger.info('== loaded cameras'))
    .catch(err => logger.error(`== error loading cameras: ${err}`))

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
  app.shutdown.push(async () => {
    logger.info('== Shutting down twitch...')
    await chat.disconnect()
  })

  chat.on('cheer', onCheerHandler)
  chat.on('chat', onChatHandler)
  chat.on('connected', onConnectedHandler)
  chat.on('disconnected', onDisconnectedHandler)
  chat.on('reconnect', () => { logger.info('== reconnecting to twitch') })

  // Connect to Twitch
  logger.info(`== connecting to twitch: ${process.env.TWITCH_USER}@${twitchChannel}`)
  chat.connect()
    .then(() => logger.info(`== connected to twitch channel: ${process.env.TWITCH_USER}@${twitchChannel}`))
    .catch(err => logger.error(`Unable to connect to twitch: ${JSON.stringify(err, null, prettySpace)}`))

  function onCheerHandler (target, context, msg) {
    logger.info(`Cheer: ${JSON.stringify({ target: target, msg: msg, context: context }, null, prettySpace)}`)

    // Automatically show the 'treat' camera at the 'cheer' shortcut if it's not already shown
    if (!obsView.inView('treat')) obsView.processChat('1treat')
    if (app.ptz.cams.has('treat')) app.ptz.cams.get('treat').moveToShortcut('cheer')

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
            break
          }
          obsView.processChat(str)
          break
        case '!bell':
          if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster)) return
          logger.debug(`${context.username} is ringing the bell`)

          // Automatically show the 'does' camera at the 'bell' shortcut if it's not already shown
          if (!obsView.inView('does')) obsView.processChat('2does')
          if (app.ptz.cams.has('does')) app.ptz.cams.get('does').moveToShortcut('bell')
          break

        case '!cams': {
          const sources = obsView.getSources().map(s => app.ptz.names.includes(s) ? `${s} (ptz)` : s)
          // Put PTZ cams first, then sort alphabetically
          sources.sort((a, b) => {
            if (a.includes('ptz') && !b.includes('ptz')) return -1
            else if (!a.includes('ptz') && b.includes('ptz')) return 1
            else if (a === b) return 0
            else return a < b ? -1 : 1
          })
          if (sources.length > 0) chat.say(twitchChannel, `Available cams: ${sources.join(', ')}`)
          else chat.say(twitchChannel, 'No cams currently available')
          break
        }
        // MOD COMMANDS
        case '!log':
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
          break

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
          break
        case '!mute':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('SetMute', { source: 'Audio', mute: true })
              .then(() => chat.say(twitchChannel, 'Stream muted'))
              .catch(e => {
                logger.error(`Unable to mute: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Unable to mute the stream!')
              })
          }
          break
        case '!unmute':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('SetMute', { source: 'Audio', mute: false })
              .then(() => chat.say(twitchChannel, 'Stream unmuted'))
              .catch(e => {
                logger.error(`Unable to unmute: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Unable to unmute the stream!')
              })
          }
          break
        case '!restartscript':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            triggerRestart(process.env.RESTART_FILE)
              .then(() => logger.info(`Triggered restart and wrote file '${process.env.RESTART_FILE}'`))
              .catch(e => logger.error(`Unable to write the restart file '${process.env.RESTART_FILE}': ${e}`))
          }
          break
        case '!stop':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('StopStreaming')
              .then(() => chat.say(twitchChannel, 'Stream stopped'))
              .catch(e => {
                logger.error(`Unable to stop OBS: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Something went wrong... unable to stop the stream')
              })
          }
          break
        case '!start':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('StartStreaming')
              .then(() => chat.say(twitchChannel, 'Stream started'))
              .catch(e => {
                logger.error(`Unable to start OBS: ${JSON.stringify(e, null, prettySpace)}`)
                chat.say(twitchChannel, 'Something went wrong... unable to start the stream')
              })
          }
          break
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
          if (app.ptz.cams.has(cam)) {
            if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster) && !admins.has(context.username.toLowerCase())) {
              sayForSubs()
              return
            }
            app.ptz.cams.get(cam).command(str)
          }
        }
      }
    })
  }
})()
  .catch(err => logger.error(`Application error: ${err}`))

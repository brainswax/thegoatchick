import tmi from 'tmi.js'
import OBSWebSocket from 'obs-websocket-js'
import OBSView from './obs-view.js'
import PTZ from './ptz.js'
import { triggerRestart } from './autostart.mjs'
import { Stojo } from '@codegrill/stojo'
import { logger } from './slacker.mjs'
import * as cenv from 'custom-env'
import crypto from 'crypto'
import WindowHandler from './windowHandler.mjs'

cenv.env(process.env.NODE_ENV)

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
async function getPTZCams (map, names, chat, channel, configFile, options = []) {
  return import(configFile)
    .catch(e => { logger.error(`Unable to import '${configFile}': ${e}`) })
    .then(conf => {
      // This assumes that the camera options are under the "cams" entry in the JSON file
      for (const [key, value] of Object.entries(conf.default.cams)) {
        value.name = key
        value.chat = chat
        value.channel = channel
        Object.assign(value, options)
        map.set(key, new PTZ(value))
        names.push(key.toLocaleLowerCase())
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
    if (!app.exited) { // only call this once
      app.exited = true
      await Promise.all(app.shutdown.map(async f => {
        try { await f() } catch { logger.error('Error shutting something down!') }
      }))
      setTimeout(() => process.exit(1), 0) // push it back on the event loop
    }
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
  process.on('SIGHUP', () => {
    console.log('\nSIGHUP received.')
    shutdown()
  })
  process.on('uncaughtException', (err, origin) => {
    logger.error(`${origin}: ${err}`)
  })
  process.on('unhandledRejection', (reason, promise) => {
    logger.warn(`Venice broke her promise to Jerry...\nPromise: ${promise.constructor.valueOf()}\nReason: ${JSON.stringify(reason, null, 2)}`)
  })
  process.on('exit', (code) => { logger.log(`== exiting with code: ${code}`) })

  await import(process.env.APP_CONFIG)
    .then(config => {
      if (config && config.default) {
        logger.debug(`Loaded app config: ${JSON.stringify(config, null, 2)}`)
        app.config = config.default
        if (!app.config.windows) app.config.windows = {}
        if (!app.config.windows.sourceTypes) app.config.windows.sourceTypes = ['dshow_input', 'ffmpeg_source']
      }
    })
    .catch(e => logger.warn(`Unable to load config ${process.env.APP_CONFIG}: ${e}`))

  // Grab the version and log it
  await import('../package.json')
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
  const admins = await adminStore.admins // load from store first

  if (admins.size === 0) { // if nothing in the store, load from the app config
    app.config.admins.forEach(admin => admins.add(admin))
    adminStore.admins = admins // persist any admins from the config
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
    windowTypes: app.config.windows.sourceTypes,
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
    if (process.env.OBS_RETRY !== 'false' && !app.exited) {
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
  // Connect to twitch
  const chat = new tmi.Client({
    identity: {
      username: process.env.TWITCH_USER,
      password: process.env.TWITCH_TOKEN
    },
    connection: { reconnect: process.env.TWITCH_RECONNECT !== 'false' },
    maxReconnectAttempts: process.env.TWITCH_RECONNECT_TRIES,
    channels: [process.env.TWITCH_CHANNEL]
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

  // ///////////////////////////////////////////////////////////////////////////
  // Load the PTZ cameras
  await getPTZCams(app.ptz.cams, app.ptz.names, chat, process.env.TWITCH_CHANNEL, process.env.PTZ_CONFIG, { logger: logger, db: db })
    .then(() => logger.info('== loaded cameras'))
    .catch(err => logger.error(`== error loading cameras: ${err}`))

  // Connect to Twitch
  logger.info(`== connecting to twitch: ${process.env.TWITCH_USER}@${process.env.TWITCH_CHANNEL}`)
  chat.connect()
    .then(() => logger.info(`== connected to twitch channel: ${process.env.TWITCH_USER}@${process.env.TWITCH_CHANNEL}`))
    .catch(err => logger.error(`Unable to connect to twitch: ${JSON.stringify(err, null, 2)}`))

  function onCheerHandler (target, context, msg) {
    logger.info(`Cheer: ${JSON.stringify({ target: target, msg: msg, context: context }, null, 2)}`)

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

  // This will process !camN commands to view and manage windows for cams/views
  app.windowHandler = new WindowHandler({
    logger: logger,
    twitch: {
      chat: chat,
      channel: process.env.TWITCH_CHANNEL
    },
    obsView: obsView
  })

  function sayForSubs () {
    chat.say(process.env.TWITCH_CHANNEL, 'This command is reserved for Subscribers')
  }

  function sayForMods () {
    chat.say(process.env.TWITCH_CHANNEL, 'This command is reserved for mods')
  }

  function chatBot (str, context) {
    // Only process the command if the message starts with a '!'
    if (!str.trim().startsWith('!')) return

    logger.info(`Command from ${context.username}: ${str}`)
    logger.debug(`Chat message:\nmessage: ${str}\nuser: ${JSON.stringify(context, null, 2)}`)

    const matches = str.trim().toLowerCase().match(/!(\w+)\b/gm)
    if (matches == null || obsView.cameraTimeout(context.username)) return

    matches.forEach(match => {
      switch (match) {
        // ANYONE COMMANDS
        case '!cams': {
          const sources = obsView.getSources(app.config.windows.sourceTypes).map(s => app.ptz.names.includes(s) ? `${s} (ptz)` : s)
          // Put PTZ cams first, then sort alphabetically
          sources.sort((a, b) => {
            if (a.includes('ptz') && !b.includes('ptz')) return -1
            else if (!a.includes('ptz') && b.includes('ptz')) return 1
            else if (a === b) return 0
            else return a < b ? -1 : 1
          })
          if (sources.length > 0) chat.say(process.env.TWITCH_CHANNEL, `Available cams: ${sources.join(', ')}`)
          else chat.say(process.env.TWITCH_CHANNEL, 'No cams currently available')
          break
        }
        case '!ptz':
          if (app.ptz.names.length > 0) chat.say(process.env.TWITCH_CHANNEL, `PTZ cams: ${app.ptz.names.join(', ')}`)
          else chat.say(process.env.TWITCH_CHANNEL, 'No PTZ cams configured')
          break

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
          logger.info(`${context.username} rang the bell`)

          // Automatically show the 'does' camera at the 'bell' shortcut if it's not already shown
          if (!obsView.inView('does')) obsView.processChat('2does')
          if (app.ptz.cams.has('does')) app.ptz.cams.get('does').moveToShortcut('bell')
          break

        // MOD COMMANDS
        case '!windows':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obsView.commandWindows(chat, process.env.TWITCH_CHANNEL, str)
          }
          break
        case '!sync':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obsView.syncFromObs()
          }
          break
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
              .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream muted'))
              .catch(e => {
                logger.error(`Unable to mute: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Unable to mute the stream!')
              })
          }
          break
        case '!unmute':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('SetMute', { source: 'Audio', mute: false })
              .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream unmuted'))
              .catch(e => {
                logger.error(`Unable to unmute: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Unable to unmute the stream!')
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
              .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream stopped'))
              .catch(e => {
                logger.error(`Unable to stop OBS: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Something went wrong... unable to stop the stream')
              })
          }
          break
        case '!start':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('StartStreaming')
              .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream started'))
              .catch(e => {
                logger.error(`Unable to start OBS: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Something went wrong... unable to start the stream')
              })
          }
          break
        case '!restart':
          if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
            obs.send('StopStreaming')
              .then(() => {
                chat.say(process.env.TWITCH_CHANNEL, 'Stream stopped. Starting in...')
                setTimeout(function () { chat.say(process.env.TWITCH_CHANNEL, ':Z Five') }, 5000)
                setTimeout(function () { chat.say(process.env.TWITCH_CHANNEL, ':\\ Four') }, 6000)
                setTimeout(function () { chat.say(process.env.TWITCH_CHANNEL, ';p Three') }, 7000)
                setTimeout(function () { chat.say(process.env.TWITCH_CHANNEL, ':) Two') }, 8000)
                setTimeout(function () { chat.say(process.env.TWITCH_CHANNEL, ':D One') }, 9000)
                setTimeout(function () {
                  obs.send('StartStreaming')
                    .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream restarted'))
                    .catch(e => {
                      logger.error(`Unable to start OBS after a restart: ${JSON.stringify(e, null, 2)}`)
                      chat.say(process.env.TWITCH_CHANNEL, 'Something went wrong... unable to restart the stream')
                    })
                }, 10000)
              })
              .catch(e => {
                logger.error(`Unable to stop OBS for a restart: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Something went wrong... the stream won\'t stop.')
              })
          }
          break
        default: {
          const cam = match.replace(/^[!]+/, '')
          if (app.ptz.cams.has(cam) || cam in obsView.getAliases() || match.startsWith('!cam')) {
            if (!context.subscriber && !context.mod && !(context.badges && context.badges.broadcaster) && !admins.has(context.username.toLowerCase())) {
              sayForSubs()
              return
            }

            if (app.ptz.cams.has(cam)) {
              app.ptz.cams.get(cam).command(str)
            }
            if (cam in obsView.getAliases()) {
              obsView.command(chat, process.env.TWITCH_CHANNEL, cam, str)
            }
            if (match.startsWith('!cam') && match.length > '!cam'.length) {
              if (context.mod || (context.badges && context.badges.broadcaster) || admins.has(context.username.toLowerCase())) {
                app.windowHandler.handleWindow(match, str)
              } else sayForMods()
            }
          }
        }
      }
    })
  }
})()
  .catch(err => logger.error(`Application error: ${err}`))

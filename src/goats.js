import tmi from 'tmi.js'
import OBSWebSocket from 'obs-websocket-js'
import OBSView from './obs-view.js'
import PTZ from './ptz.js'
import { triggerRestart } from './autostart.mjs'
import { Stojo } from '@codegrill/stojo'
import { logger } from './slacker.mjs'
import * as cenv from 'custom-env'
import crypto from 'crypto'
import WindowHerder from './windowHerder.mjs'
import SceneHerder from './sceneHerder.mjs'
import linkit from './linkit.mjs'

cenv.env(process.env.NODE_ENV)

// Set default config file locations
if (!process.env.PTZ_CONFIG || process.env.PTZ_CONFIG === '') { process.env.PTZ_CONFIG = '../conf/ptz.json' }
if (!process.env.DB_FILE || process.env.DB_FILE === '') { process.env.DB_FILE = './goatdb.sqlite3' }
if (!process.env.APP_CONFIG || process.env.APP_CONFIG === '') { process.env.APP_CONFIG = '../conf/goats.json' }

// Grab log levels to console and slack
logger.level.console = logger[process.env.LOG_LEVEL_CONSOLE] || logger.level.console
logger.level.slack = logger[process.env.LOG_LEVEL_SLACK] || logger.level.slack

/**
 * Get the PTZ config and connect to the cameras
 * @param {Map} map to populate with Cam objects
 * @param {Array} names to populate with camera names
 * @param {string} configFile the config file to load the camera information from
 * @param {string} element the element in the config file to grab the list from
 * @param {Object} options the options given to the Cam object
 * @returns an empty promise
 */
async function initCams (map, names, configFile, element, options = {}) {
  return import(configFile)
    .catch(e => { logger.error(`Unable to import '${configFile}': ${e}`) })
    .then(conf => {
      // Grab the appropriate entry from the config file
      if (element in conf.default) {
        for (const [key, value] of Object.entries(conf.default[element])) {
          value.name = key
          Object.assign(value, options)
          map.set(key, new PTZ(value))
          names.push(key.toLocaleLowerCase())
        }
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
        if (admins) this.logger.debug(`loaded the stored admins: ${JSON.stringify(admins)}`)
        return new Set(admins)
      })
      .catch(err => this.logger.warn(`loading the admins: ${err}`))
  }

  set admins (admins) {
    const a = Array.from(admins)
    this.logger.debug(`store the admins: ${JSON.stringify(a)}`)
    this.db.store(this.key, a)
      .catch(err => this.logger.warn(`storing the admins: ${err}`))
  }
}

;(async () => {
  const app = {}
  app.exited = false
  app.obs = {}

  // PTZ controllable cameras
  app.ptz = {}
  app.ptz.names = []
  app.ptz.cams = new Map()

  // Non-PTZ network cams
  app.ipcams = {}
  app.ipcams.names = []
  app.ipcams.cams = new Map()

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

  function isSubscriber (context) {
    return context.subscriber || isModerator(context)
  }

  function isModerator (context) {
    return context.mod || app.admins.has(context.username.toLowerCase()) || isBroadcaster(context)
  }

  function isBroadcaster (context) {
    return context.badges && context.badges.broadcaster
  }

  await import(process.env.APP_CONFIG)
    .then(config => {
      if (config && config.default) {
        logger.debug(`Loaded app config: ${JSON.stringify(config)}`)
        app.config = JSON.parse(JSON.stringify(config.default)) // deep copy

        // Set defaults if they don't exist
        if (!app.config.windows) app.config.windows = {}
        if (!app.config.windows.sourceKinds) app.config.windows.sourceKinds = ['dshow_input', 'ffmpeg_source']
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
  const db = new Stojo({ logger, file: process.env.DB_FILE })
  app.shutdown.push(() => {
    logger.info('== Shutting down the local database...')
    db.close()
  })
  const adminStore = new AdminStore({ logger, db })
  app.admins = await adminStore.admins // load from store first

  if (app.admins.size === 0) { // if nothing in the store, load from the app config
    app.config.admins.forEach(admin => app.admins.add(admin))
    adminStore.admins = app.admins // persist any admins from the config
  }

  // ///////////////////////////////////////////////////////////////////////////
  // Connect to OBS
  const obs = new OBSWebSocket()
  app.shutdown.push(async () => {
    logger.info('== Shutting down OBS...')
    obs.disconnect()
  })
  const obsView = new OBSView({
    obs,
    db,
    windowKinds: app.config.windows.sourceKinds,
    logger
  })

  async function connectOBS (obs) {
    logger.info(`== connecting to OBS host:${process.env.OBS_ADDRESS}, hash: ${crypto.createHash('sha256').update(process.env.OBS_PASSWORD).digest('base64')}`)
    return obs.connect('ws://' + process.env.OBS_ADDRESS, process.env.OBS_PASSWORD)
      .then(() => {
        app.obs.retries = 0 // Reset for the next disconnect
        logger.info('== connected to OBS')

        return obsView.syncFromObs()
      })
      .then(() => {
        return obs.call('GetVideoSettings')
      })
      .then(info => {
        // Need the info to get the stream resolution
        logger.info(`Stream Base Resolution: ${info.baseWidth}x${info.baseHeight}, Output Resolution: ${info.outputWidth}x${info.outputHeight}`)
        logger.debug(`Video Info: ${JSON.stringify(info, null, 2)}`)
        return info
      })
  }

  function reconnectOBS () {
    // If the connection closes, retry after the timeout period
    if (process.env.OBS_RETRY !== 'false' && !app.exited) {
      const delay = Math.round((process.env.OBS_RETRY_DELAY || 3000) * ((process.env.OBS_RETRY_DECAY || 1.2) ** app.obs.retries++))
      logger.info(`OBS reconnect delay: ${delay / 1000} seconds, retries: ${app.obs.retries}`)
      setTimeout(() => {
        app.stream.info = connectOBS(obs)
          .catch(e => {
            logger.error(`Connection retry to OBS failed: ${e.message}`)
          })
      }, delay)
    }
  }

  // Connect/auth events
  obs.on('ConnectionOpened', () => { logger.info('== OBS connection opened') })
  obs.on('ConnectionClosed', () => {
    logger.info('== OBS connection closed')
    reconnectOBS()
  })
  obs.on('AuthenticationSuccess', () => { logger.info('== OBS successfully authenticated') })
  obs.on('AuthenticationFailure', () => { logger.info('== OBS failed authentication') })
  obs.on('error', e => logger.error(`== OBS error: ${e.message}`))

  // OBS events - working
  obs.on('SceneItemEnableStateChanged', data => obsView.sceneItemEnableStateChanged(data)) // hide/show source
  obs.on('SceneItemListReindexed', data => obsView.sourceOrderChanged(data))
  obs.on('CurrentProgramSceneChanged', data => obsView.switchScenes(data))
  obs.on('SceneItemCreated', data => obsView.sceneItemCreated(data))
  obs.on('SceneItemRemoved', data => obsView.sceneItemRemoved(data))
  obs.on('InputNameChanged', data => obsView.inputNameChanged(data))
  obs.on('MediaInputPlaybackStarted', data => obsView.mediaInputPlaybackStarted(data))
  obs.on('MediaInputPlaybackEnded', data => obsView.mediaInputPlaybackEnded(data))

  // OBS events not implemented in obs-websocket
  obs.on('SceneItemTransformChanged', data => obsView.sceneItemTransformChanged(data))

  // Connect to OBS
  app.stream.info = connectOBS(obs)
    .catch(e => {
      logger.error(`Connect OBS failed: ${e.message}`)
    })

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
  await initCams(app.ptz.cams, app.ptz.names, process.env.PTZ_CONFIG, 'cams', { chat, channel: process.env.TWITCH_CHANNEL, logger, db })
    .then(() => logger.info('== loaded PTZ cameras'))
    .catch(err => logger.error(`== error loading PTZ cameras: ${err}`))

  // Load any non-PTZ network cameras
  await initCams(app.ipcams.cams, app.ipcams.names, process.env.PTZ_CONFIG, 'static', { chat, channel: process.env.TWITCH_CHANNEL, logger, db })
    .then(() => logger.info('== loaded IP cameras'))
    .catch(err => logger.error(`== error loading IP cameras: ${err}`))

  // Connect to Twitch
  logger.info(`== connecting to twitch: ${process.env.TWITCH_USER}@${process.env.TWITCH_CHANNEL}`)
  chat.connect()
    .then(() => logger.info(`== connected to twitch channel: ${process.env.TWITCH_USER}@${process.env.TWITCH_CHANNEL}`))
    .catch(err => logger.error(`Unable to connect to twitch: ${JSON.stringify(err, null, 2)}`))

  function onCheerHandler (target, context, msg) {
    logger.debug(`Cheer: ${JSON.stringify({ target, msg, context }, null, 2)}`)

    // Automatically show the 'treat' camera at the 'cheer' shortcut if it's not already shown
    if (!obsView.inView('treat')) obsView.processChat('1treat')
    if (app.ptz.cams.has('treat')) app.ptz.cams.get('treat').moveToShortcut('cheer')

    // Process this last to ensure the auto-treat doesn't override a cheer command
    obsView.processChat(msg)
  }

  function onChatHandler (target, context, msg) {
    try {
      if (app.config.ignore && app.config.ignore.includes(context['display-name'])) return // ignore the bots

      chatBot(context, msg) // Process chat commands
      linkit(context, msg) // Send any links to slack
    } catch (e) {
      logger.error(`processing chat: ${JSON.stringify(e)}, context: ${JSON.stringify(context)}`)
    }
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
  {
    const options = {
      logger,
      twitch: {
        chat,
        channel: process.env.TWITCH_CHANNEL
      },
      obsView
    }
    app.windowHerder = new WindowHerder(options)
    app.sceneHerder = new SceneHerder(options)
  }
  function sayForSubs (message) {
    chat.say(process.env.TWITCH_CHANNEL, message || 'This command is reserved for subscribers')
  }
  function sayForMods (message) {
    chat.say(process.env.TWITCH_CHANNEL, message || 'This command is reserved for moderators')
  }

  function chatBot (context, str) {
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
          const sources = obsView.getSources(app.config.windows.sourceKinds).map(s => app.ptz.names.includes(s) ? `${s.replace(/\W/g, '-')} (ptz)` : s.replace(/\W/g, '-'))
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
          if (isSubscriber(context)) obsView.processChat(str)
          else sayForSubs()

          break
        case '!bell':
          if (!isSubscriber(context)) break
          logger.info(`${context.username} rang the bell`)

          // Automatically show the 'does' camera at the 'bell' shortcut if it's not already shown
          if (!obsView.inView('does')) obsView.processChat('2does')
          if (app.ptz.cams.has('does')) app.ptz.cams.get('does').moveToShortcut('bell')
          break
        case '!scene':
        case '!scenes':
          if (isSubscriber(context)) app.sceneHerder.herd(match, str)
          else sayForSubs()
          break
        // MOD COMMANDS
        case '!windows':
          if (isModerator(context)) obsView.commandWindows(chat, process.env.TWITCH_CHANNEL, str)
          break
        case '!sync':
          if (isModerator(context)) obsView.syncFromObs()
          break
        case '!log':
          if (isModerator(context)) {
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
          if (isModerator(context)) {
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
                    app.admins.add(value)
                    break
                  case 'delete':
                  case 'remove':
                    logger.info(`Removing admin '${value}'`)
                    app.admins.delete(value)
                    break
                }
                adminStore.admins = app.admins
              }
            })
          }
          break
        case '!mute':
          if (isModerator(context)) {
            obs.call('SetMute', { source: 'Audio', mute: true })
              .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream muted'))
              .catch(e => {
                logger.error(`Unable to mute: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Unable to mute the stream!')
              })
          }
          break
        case '!unmute':
          if (isModerator(context)) {
            obs.call('SetMute', { source: 'Audio', mute: false })
              .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream unmuted'))
              .catch(e => {
                logger.error(`Unable to unmute: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Unable to unmute the stream!')
              })
          }
          break
        case '!restartscript':
          if (isModerator(context)) {
            triggerRestart(process.env.RESTART_FILE)
              .then(() => logger.info(`Triggered restart and wrote file '${process.env.RESTART_FILE}'`))
              .catch(e => logger.error(`Unable to write the restart file '${process.env.RESTART_FILE}': ${e}`))
          }
          break
        case '!stop':
          if (isModerator(context)) {
            obs.call('StopStream')
              .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream stopped'))
              .catch(e => {
                logger.error(`Unable to stop OBS: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Something went wrong... unable to stop the stream')
              })
          }
          break
        case '!start':
          if (isModerator(context)) {
            obs.call('StartStream')
              .then(() => chat.say(process.env.TWITCH_CHANNEL, 'Stream started'))
              .catch(e => {
                logger.error(`Unable to start OBS: ${JSON.stringify(e, null, 2)}`)
                chat.say(process.env.TWITCH_CHANNEL, 'Something went wrong... unable to start the stream')
              })
          }
          break
        case '!restart':
          if (isModerator(context)) {
            obs.call('StopStream')
              .then(() => {
                chat.say(process.env.TWITCH_CHANNEL, 'Stream stopped. Restarting in 10 seconds...')
                setTimeout(function () {
                  obs.call('StartStream')
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
          const sub = isSubscriber(context)
          const mod = isModerator(context)
          let saySubsOnly = false

          // A command for a PTZ camera
          if (app.ptz.cams.has(cam)) {
            if (str.includes(' reboot') && !mod) {
              sayForMods('The reboot command is reserved for moderators')
            } else if (sub) app.ptz.cams.get(cam).command(str)
            else saySubsOnly = true
          }
          // A command for a non-PTZ camera
          if (app.ipcams.cams.has(cam)) {
            if (str.includes(' reboot') && !mod) {
              sayForMods('The reboot command is reserved for moderators')
            } else if (sub) app.ipcams.cams.get(cam).command(str)
            else saySubsOnly = true
          }
          // A command to modify an OBS source cam
          if (obsView.hasSourceAlias(cam)) {
            if (sub) obsView.command(chat, process.env.TWITCH_CHANNEL, cam, str)
            else saySubsOnly = true
          }
          // A command for a window
          if (match.startsWith('!cam')) {
            if (sub) app.windowHerder.herd(match, str)
            else saySubsOnly = true
          }

          if (saySubsOnly) sayForSubs()
        }
      }
    })
  }
})()
  .catch(err => logger.error(`Application error: ${err}`))

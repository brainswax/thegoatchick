import tmi from 'tmi.js'
import OBSWebSocket from 'obs-websocket-js'
import OBSView from './obs-view.js'
import PTZ from './ptz.js'
import * as cenv from 'custom-env'

cenv.env(process.env.NODE_ENV)
const obs = new OBSWebSocket()

// Connect to OBS
obs.connect({ address: process.env.OBS_ADDRESS, password: process.env.OBS_PASSWORD })
  .then(() => console.info('OBS connected'))
  .catch(err => console.error(`OBS connection failed: ${err}`))

// Set up OBS window changer
const obsView = new OBSView(obs)
obsView.addView('Runout', ['runout'])
obsView.addView('Bucks', ['bucks'])
obsView.addView('Does', ['does'])
obsView.addView('Kids', ['kids'])
obsView.addView('Feeder', ['feeder'])
obsView.addView('Parlor', ['parlor'])
obsView.addView('KiddingA', ['kiddinga'])
obsView.addView('KiddingB', ['kiddingb'])
obsView.addView('Yard', ['yard'])
obsView.addView('Treat', ['treat'])
obsView.addView('Buckpen', ['buckpen'])
obsView.addView('Loft', ['loft'])
obsView.addView('Pasture', ['pasture'])

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
        c.set(key, new PTZ(value))
      }

      return c
    })
    .catch(e => { console.error(`import error: ${e}`) })
}

// Load the PTZ cameras
const cams = getPTZCams(process.env.PTZ_CONFIG)
  .catch(err => console.err(`Error getting PTZ cams: ${err}`))

// twitch IRC options
// CHANGE ME: set OAUTH key
const twitchChannel = process.env.TWITCH_CHANNEL
const opts = {
  identity: {
    username: process.env.TWITCH_USER,
    password: process.env.TWITCH_TOKEN
  },
  connection: { reconnect: true },
  channels: [twitchChannel]
}

// Create a client with our options:
const chat = new tmi.Client(opts)

chat.on('cheer', onCheerHandler)
chat.on('chat', onChatHandler)
chat.on('connected', onConnectedHandler)
chat.on('disconnected', onDisconnectedHandler)

// Connect to Twitch:
chat.connect()

function onCheerHandler (target, context, msg) {
  obsView.processChat(msg)
}

function onChatHandler (target, context, msg) {
  if (context['display-name'] === 'HerdBoss') return // ignore the bot
  chatBot(msg, context)
}

// Called every time the bot connects to Twitch chat:
function onConnectedHandler (addr, port) {
  console.info(`* Connected to ${addr}:${port}`)
}

// Called every time the bot disconnects from Twitch:
// TODO: reconnect rather than exit
function onDisconnectedHandler (reason) {
  console.info(`Disconnected: ${reason}`)
  process.exit(1)
}

function sayForSubs () {
  chat.say(twitchChannel, 'This command is reserved for Subscribers')
}

function chatBot (str, context) {
  const wordsRegex = /!(\w+)\b/gm

  const matches = str.toLowerCase().match(wordsRegex)
  if (matches == null) return

  if (obsView.cameraTimeout(context.username)) return
  matches.forEach(match => {
    switch (match) {
      // SUBSCRIBER COMMANDS
      case '!cam':
      case '!camera':
        if (!context.subscriber) {
          sayForSubs()
          return
        }
        obsView.processChat(str)
        return
      case '!treat':
        if (!context.subscriber) {
          sayForSubs()
          return
        }
        cams.get('treat').command(str)
        return
      case '!does':
        if (!context.subscriber) {
          sayForSubs()
          return
        }
        cams.get('does').command(str)
        return
      case '!yard':
        if (!context.subscriber) {
          sayForSubs()
          return
        }
        cams.get('yard').command(str)
        return
      case '!kids':
        if (!context.subscriber) {
          sayForSubs()
          return
        }
        cams.get('kids').command(str)
        return
      case '!pasture':
        if (!context.subscriber) {
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

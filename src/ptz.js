import { Cam } from 'onvif'
import { Stojo } from '@codegrill/stojo'
import crypto from 'crypto'

const panRegex = /(p|pan|right|left|r|l) ?(\+|-)? ?([0-9]{1,3})/m
const tiltRegex = /(t|tilt|down|up|d|u) ?(\+|-)? ?([0-9]{1,3})/m
const zoomRegex = /(z|zoom|in|out|i|o) ?(\+|-)? ?([0-9]{1,3})/m

function coordsEqual (c1, c2) {
  return c1.pan === c2.pan & c1.tilt === c2.tilt & c1.zoom === c2.zoom
}

class NullChat {
  constructor (options) {
    this.logger = options.logger || console
  }

  say (channel, message) {
    this.logger.warn(`No chat established to respond on channel '${this.channel || 'unknown'}': ${message}`)
  }
}

export default class PTZ {
  constructor (options) {
    this.name = options.name || 'unnamed'
    this.version = options.version || 2

    this.logger = options.logger || console
    this.db = options.db || new Stojo({ logger: this.logger })
    this.data = {}

    this.logger.info(`== connecting to PTZ camera host: ${options.hostname}, user: ${options.username}, hash: ${crypto.createHash('sha256').update(options.password).digest('base64')}`)
    this.chat = options.chat || new NullChat({ logger: this.logger })
    this.channel = options.channel

    this.cam = new Cam({
      hostname: options.hostname,
      username: options.username,
      password: options.password
    }, err => {
      if (err) this.logger.warn(`== failed to connect to PTZ camera '${this.name}': ${err}`)
      else this.logger.info(`== connected to PTZ camera '${this.name}'`)
    })

    this.systemReboot = async () => {
      return new Promise((resolve, reject) => {
        this.cam.systemReboot((err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
    }

    this.getDeviceInformation = async () => {
      return new Promise((resolve, reject) => {
        this.cam.getDeviceInformation((err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
    }

    this.getCapabilities = async () => {
      return new Promise((resolve, reject) => {
        this.cam.getCapabilities((err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
    }

    this.getServiceCapabilities = async () => {
      return new Promise((resolve, reject) => {
        this.cam.getServiceCapabilities((err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
    }

    this.getScopes = async () => {
      return new Promise((resolve, reject) => {
        this.cam.getScopes((err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
    }

    this.getStatus = async (options) => {
      return new Promise((resolve, reject) => {
        this.cam.getStatus(options, (err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
    }

    this.storedPosition
      .then(coords => {
        this.data.coords = coords || { pan: 240, tilt: 20, zoom: 0 }
        this.logger.debug(`initial camera position for ${this.name}: ${JSON.stringify(this.data.coords)}`)
      })
      .catch(err => this.logger.error(`initializing camera position for ${this.name}: ${err}`))

    this.storedShortcuts
      .then(shortcuts => {
        this.data.shortcuts = shortcuts || {}
        this.logger.debug(`initial camera shortcuts for '${this.name}': ${JSON.stringify(this.data.shortcuts)}`)
      })
      .catch(err => this.logger.error(`initializing camera shortcuts for ${this.name}: ${err}`))

    this.commands = new Map()
    this.commands.set('save', (...args) => this.saveShortcut(...args))
    this.commands.set('s', (...args) => this.saveShortcut(...args))
    this.commands.set('delete', (...args) => this.deleteShortcut(...args))
    this.commands.set('d', (...args) => this.deleteShortcut(...args))
    this.commands.set('info', (...args) => this.showShortcut(...args))
    this.commands.set('i', (...args) => this.showShortcut(...args))
    this.commands.set('shortcuts', (...args) => this.showShortcut(...args))
    this.commands.set('position', (...args) => this.showPosition(...args))
    this.commands.set('pos', (...args) => this.showPosition(...args))
    this.commands.set('reboot', (...args) => this.doReboot(...args))
    this.commands.set('dev', (...args) => this.doDevice(...args))
  }

  /**
  This function is used to correct position object structure that has changed between versions of this software
  */
  fixupPosition (coords) {
    // This used to store both the coords and shortcuts. It should only store coords now.
    if (coords && 'coords' in coords) {
      this.logger.debug(`fixing up the cached position for camera: ${this.name}: ${JSON.stringify(coords)}`)
      coords = JSON.parse(JSON.stringify(coords.coords))
      this.storedPosition = coords
    }

    return coords
  }

  /**
  This function is used to correct shortcuts object structure that has changed between versions of this software
  */
  fixupShortcuts (shortcuts) {
    // Nothing to fix
    return shortcuts
  }

  /**
  Gets the key for storing this cameras position
  */
  get positionkey () {
    return `ptz.${this.name}.position`
  }

  /**
  Gets the key for storing this cameras shortcuts
  */
  get shortcutskey () {
    return `ptz.${this.name}.shortcuts`
  }

  get storedPosition () {
    return this.db.fetch(this.positionkey)
      .then(coords => {
        if (coords) this.logger.debug(`loaded the camera position for '${this.name}': ${JSON.stringify(coords)}`)
        return this.fixupPosition(coords)
      })
  }

  set storedPosition (coords) {
    this.logger.debug(`store the camera position for '${this.name}': ${JSON.stringify(coords)}`)
    this.db.store(this.positionkey, coords) // Persist the current position
      .catch(err => this.logger.warn(`storing the camera position for '${this.name}': ${err}`))
  }

  get storedShortcuts () {
    return this.db.fetch(this.shortcutskey)
      .then(shortcuts => {
        if (shortcuts) this.logger.debug(`loaded the camera shortcuts for '${this.name}': ${JSON.stringify(shortcuts)}`)
        return this.fixupShortcuts(shortcuts)
      })
      .catch(err => this.logger.warn(`loading the camera shortcuts for '${this.name}': ${err}`))
  }

  set storedShortcuts (shortcuts) {
    this.logger.debug(`store the camera shortcuts for '${this.name}': ${JSON.stringify(shortcuts)}`)
    this.db.store(this.shortcutskey, shortcuts)
      .catch(err => this.logger.warn(`storing the camera shortcuts for '${this.name}': ${err}`))
  }

  move (coords) {
    this.storedPosition = coords
    this.logger.debug(`Moving camera '${this.name}' to coordinates: ${JSON.stringify(coords)}`)

    try {
      this.cam.absoluteMove({
        x: this.calcPan(coords.pan),
        y: this.calcTilt(coords.tilt),
        zoom: this.calcZoom(coords.zoom)
      }, (err) => { if (err) this.logger.warn(`unable to move camera ${this.name}: ${err}`) })
    } catch (err) {
      if (this.cam.activeSources) this.logger.info(`No active sources for '${this.name}'`)
      this.logger.warn(`Cam.absoluteMove threw an exception moving camera ${this.name}: ${err}`)
    }
  }

  calcPan (pan) {
    let v = Number(pan)

    if (v < 0) v = 0
    if (v > 360) v = 360

    // process user set limits

    this.data.coords.pan = v
    if (this.version === 2) {
      if (v <= 180) {
        return Number((v * 0.0055555).toFixed(2))
      } else {
        v = v - 180
        return Number(((v * 0.0055555) - 1).toFixed(2))
      }
    } else {
      return Number(((v * 0.0055555) - 1).toFixed(2))
    }
  }

  calcTilt (tilt) {
    let v = Number(tilt)

    if (v < 0) v = 0
    if (v > 90) v = 90

    // process user set limits

    this.data.coords.tilt = v
    if (this.version === 2) {
      return Number((((v * 0.0222222) - 1) * -1).toFixed(2))
    } else {
      return Number(((v * 0.0222222) - 1).toFixed(2))
    }
  }

  calcZoom (zoom) {
    let v = Number(zoom)

    if (v < 0) v = 0
    if (v > 100) v = 100

    // process user set limits
    this.data.coords.zoom = v
    return Number((v * 0.01).toFixed(2))
  }

  status () {
    try {
      if (this.cam.activeSources) { // If the camera is connected
        this.cam.getStatus({}, (err, res) => {
          if (err) this.logger.warn(`Unable to get camera status for '${this.name}': ${err}`)
          else this.logger.debug(`getStatus of '${this.name}' returned: ${JSON.stringify(res, null, '  ')}`)
        })
      } else {
        this.logger.info(`unable to get status for offline camera '${this.name}'`)
      }
    } catch (err) {
      this.logger.warn(`Cam.getStatus threw an exception getting status for camera ${this.name}: ${err}`)
    }
  }

  saveShortcut (shortcut) {
    if (shortcut && shortcut !== '*') {
      this.logger.debug(`saving shortcut: { camera: '${this.name}', shortcut: ${JSON.stringify(shortcut)}, coords: ${JSON.stringify(this.data.coords)} }`)
      this.data.shortcuts[shortcut] = JSON.parse(JSON.stringify(this.data.coords)) // deep copy
      this.storedShortcuts = this.data.shortcuts
    }
  }

  deleteShortcut (shortcut) {
    if (shortcut === '*') { // delete all shortcuts
      this.logger.info(`Deleting all shortcuts for camera '${this.name}'`)
      this.data.shortcuts = {}
      this.storedShortcuts = this.data.shortcuts
    } else if (shortcut && this.data.shortcuts[shortcut]) {
      this.logger.debug(`Deleting shortcut: { camera: '${this.name}', shortcut: ${shortcut}, coords: ${JSON.stringify(this.data.shortcuts[shortcut])} }`)
      delete this.data.shortcuts[shortcut]
      this.storedShortcuts = this.data.shortcuts
    } else if (shortcut) this.chat.say(this.channel, `No shortcut named '${shortcut}' for cam ${this.name}`)
  }

  showShortcut (shortcut) {
    if (!shortcut || shortcut === '*') {
      const snames = Object.keys(this.data.shortcuts)
      if (snames.length === 0) this.chat.say(this.channel, `There are no shortcuts for ${this.name}`)
      else this.chat.say(this.channel, `${this.name} shortcuts: ${snames.join(', ')}`)
    } else if (this.data.shortcuts[shortcut]) {
      this.chat.say(this.channel, `${shortcut} pan: ${this.data.shortcuts[shortcut].pan}, tilt: ${this.data.shortcuts[shortcut].tilt}, zoom: ${this.data.shortcuts[shortcut].zoom}`)
      this.logger.debug(`show shortcut: { camera: '${this.name}', shortcut: ${shortcut}, coords: ${JSON.stringify(this.data.shortcuts[shortcut])} }`)
    } else this.chat.say(this.channel, `No shortcut named '${shortcut}' for cam ${this.name}`)
  }

  showPosition (shortcut) {
    if (!shortcut || shortcut === '*') {
      this.chat.say(this.channel, `pan: ${this.data.coords.pan}, tilt: ${this.data.coords.tilt}, zoom: ${this.data.coords.zoom}`)
    } else if (this.data.shortcuts[shortcut]) {
      this.chat.say(this.channel, `${shortcut} pan: ${this.data.shortcuts[shortcut].pan}, tilt: ${this.data.shortcuts[shortcut].tilt}, zoom: ${this.data.shortcuts[shortcut].zoom}`)
      this.logger.debug(`show shortcut: { camera: '${this.name}', shortcut: ${shortcut}, coords: ${JSON.stringify(this.data.shortcuts[shortcut])} }`)
    } else this.chat.say(this.channel, `No shortcut named '${shortcut}' for cam ${this.name}`)
  }

  doReboot () {
    this.systemReboot()
      .then(result => { this.logger.info(`Camera '${this.name}' successfully rebooted with status: ${JSON.stringify(result)}`) })
      .catch(e => { this.logger.error(`Unable to reboot camera '${this.name}': ${JSON.stringify(e)}`) })
  }

  doDevice (command) {
    switch (command) {
      case 'cap':
      case 'caps':
      case 'capabilities':
        this.getCapabilities()
          .then((info) => {
            this.logger.info(`Camera '${this.name}' device capabilities: ${JSON.stringify(info, null, 2)}`)
          })
          .catch(e => { this.logger.error(`Unable to get capabilities for '${this.name}': ${JSON.stringify(e)}`) })
        break
      case 'service':
      case 'services':
        this.getServiceCapabilities()
          .then((info) => {
            this.logger.info(`Camera '${this.name}' service capabilities: ${JSON.stringify(info, null, 2)}`)
          })
          .catch(e => { this.logger.error(`Unable to get service capabilities for '${this.name}': ${JSON.stringify(e)}`) })
        break
      case 'source':
      case 'sources':
        this.logger.info(`Camera '${this.name}' active sources: ${JSON.stringify(this.cam.activeSources, null, 2)}`)
        break
      case 'scope':
      case 'scopes':
        this.getScopes()
          .then((info) => {
            this.logger.info(`Camera '${this.name}' scopes: ${JSON.stringify(info, null, 2)}`)
          })
          .catch(e => { this.logger.error(`Unable to get service scopes for '${this.name}': ${JSON.stringify(e)}`) })
        break
      case 'status':
        this.getStatus({})
          .then((info) => {
            this.logger.info(`Camera '${this.name}' status: ${JSON.stringify(info, null, 2)}`)
          })
          .catch(e => { this.logger.error(`Unable to get service scopes for '${this.name}': ${JSON.stringify(e)}`) })
        break
      case 'active':
        this.logger.info(`Camera '${this.name}' active source: ${JSON.stringify(this.cam.activeSource, null, 2)}`)
        break
      default:
        this.getDeviceInformation()
          .then((info) => {
            this.logger.info(`Camera '${this.name}' device info: ${JSON.stringify(info)}`)
            this.chat.say(this.channel, `Camera '${this.name}' model ${info.model}, version ${info.firmwareVersion}`)
          })
          .catch(e => { this.logger.error(`Unable to get camera information for '${this.name}': ${JSON.stringify(e)}`) })
        break
    }
  }

  /**
  Move directly to the named shortcut if it exists
  @param shortcut name of the shortcut
  */
  moveToShortcut (shortcut) {
    if (shortcut in this.data.shortcuts) {
      this.data.coords = this.data.shortcuts[shortcut]
      this.move(this.data.coords)
    } else {
      this.logger.debug(`Shortcut '${shortcut}' does not exist for camera '${this.name}'`)
    }
  }

  apply (cmd) {
    if (cmd.search(panRegex) >= 0 || cmd.search(tiltRegex) >= 0 || cmd.search(zoomRegex) >= 0) {
      this.logger.debug(`move camera '${this.name}': ${cmd}`)
      this.applyMove(cmd)
    } else if (this.commands.has(cmd)) {
      this.logger.debug(`command camera '${this.name}': ${cmd}`)
      this.applyCommand(cmd)
    } else if (this.data.shortcuts[cmd]) {
      this.logger.debug(`shortcut camera '${this.name}': ${cmd}`)
      this.data.coords = JSON.parse(JSON.stringify(this.data.shortcuts[cmd]))
    } else {
      this.logger.debug(`command camera '${this.name}': ${cmd}`)
      this.applyCommand(cmd)
    }
  }

  applyCommand (cmd) {
    const [command, shortcut] = cmd.split(/[:]+/)
    if (this.commands.has(command)) this.commands.get(command)(shortcut)
    else if (this.commands.has(cmd)) this.commands.get(cmd)('*')
  }

  applyMove (cmd) {
    let p = []; let t = []; let z = []

    if (cmd.search(panRegex) >= 0) { p = [...panRegex.exec(cmd)] }
    if (cmd.search(tiltRegex) >= 0) { t = [...tiltRegex.exec(cmd)] }
    if (cmd.search(zoomRegex) >= 0) { z = [...zoomRegex.exec(cmd)] }

    if (p.length !== 0) this.data.coords.pan = this.getVal(p, this.data.coords.pan)
    if (t.length !== 0) this.data.coords.tilt = this.getVal(t, this.data.coords.tilt)
    if (z.length !== 0) this.data.coords.zoom = this.getVal(z, this.data.coords.zoom)

    this.logger.debug(`camera '${this.name}' moved: ${JSON.stringify(this.data.coords)}}`)
  }

  command (txt) {
    const oldCoords = JSON.parse(JSON.stringify(this.data.coords))

    const words = txt.trim().toLowerCase()
      .replace(/[a-z]+[\s]+[\d]+/g, (s) => { return s.replace(/[\s]+/, '') }) // replace something like '1 treat' with '1treat'
      .replace(/[a-z][\s]+[+:-]/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces before a colon
      .replace(/[a-z][+:-][\s]+/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces after a colon
      .replace(/[!]+[\S]+[\s]+/, '') // remove the !cam at the beginning
      .split(/[\s]+/) // split on whitespace

    words.forEach(cmd => { this.apply(cmd) })

    if (!coordsEqual(oldCoords, this.data.coords)) {
      this.move(this.data.coords)
      this.logger.debug(`previous camera ${this.name} position: ${JSON.stringify(oldCoords)}`)
      this.logger.info(`moved camera '${this.name}' to: ${JSON.stringify(this.data.coords)}}`)
    }
  }

  getVal (matches, current) {
    let abs = true
    let isPos = true
    let val = 0
    let pos = Number(current)
    matches.forEach(match => {
      if (!isNaN(match)) val = match
      switch (match) {
        case '-':
        case 'l':
        case 'left':
        case 'u':
        case 'up':
        case 'o':
        case 'out':
          abs = false
          isPos = false
          break
        case '+':
        case 'r':
        case 'right':
        case 'd':
        case 'down':
        case 'i':
        case 'in':
          abs = false
          isPos = true
          break
      }
    })

    if (abs) {
      pos = Number(val)
    } else {
      if (isPos) {
        pos += Number(val)
      } else {
        pos -= Number(val)
      }
    }
    return pos
  }
}

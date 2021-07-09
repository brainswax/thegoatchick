import { Cam } from 'onvif'
import { GoatStore } from './goatstore.mjs'

const panRegex = /(p|pan|right|left|r|l) ?(\+|-)? ?([0-9]{1,3})/m
const tiltRegex = /(t|tilt|down|up|d|u) ?(\+|-)? ?([0-9]{1,3})/m
const zoomRegex = /(z|zoom|in|out|i|o) ?(\+|-)? ?([0-9]{1,3})/m

function coordsEqual (c1, c2) {
  return c1.pan === c2.pan & c1.tilt === c2.tilt & c1.zoom === c2.zoom
}

export default class PTZ {
  constructor (options) {
    this.name = options.name || 'unnamed'
    this.version = options.version || 1

    this.logger = options.logger || console
    this.db = options.db || new GoatStore({ logger: this.logger })
    this.data = {}

    this.cam = new Cam({
      hostname: options.hostname,
      username: options.username,
      password: options.password
    }, err => {
      if (err) this.logger.warn(`failed to connect to camera '${this.name}': ${err}`)
      else this.logger.info(`connected to camera: ${this.name}`)
    })

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
    this.commands.set('show', (...args) => this.showShortcut(...args))
    this.commands.set('info', (...args) => this.showShortcut(...args))
    this.commands.set('i', (...args) => this.showShortcut(...args))
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
    return `ptz.cam.${this.name}` // TODO: change to match a similar structure to the shortcuts key: ptz.{name}.coords
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
        if (coords) this.logger.info(`loaded the camera position for '${this.name}': ${JSON.stringify(coords)}`)
        return this.fixupPosition(coords)
      })
      .catch(err => this.logger.warn(`loading the camera position for '${this.name}': ${err}`))
  }

  set storedPosition (coords) {
    this.logger.info(`store the camera position for '${this.name}': ${JSON.stringify(coords)}`)
    this.db.store(this.positionkey, coords) // Persist the current position
      .catch(err => this.logger.warn(`storing the camera position for '${this.name}': ${err}`))
  }

  get storedShortcuts () {
    return this.db.fetch(this.shortcutskey)
      .then(shortcuts => {
        if (shortcuts) this.logger.info(`loaded the camera shortcuts for '${this.name}': ${JSON.stringify(shortcuts)}`)
        return this.fixupShortcuts(shortcuts)
      })
      .catch(err => this.logger.warn(`loading the camera shortcuts for '${this.name}': ${err}`))
  }

  set storedShortcuts (shortcuts) {
    this.logger.info(`store the camera shortcuts for '${this.name}': ${JSON.stringify(shortcuts)}`)
    this.db.store(this.shortcutskey, shortcuts)
      .catch(err => this.logger.warn(`storing the camera shortcuts for '${this.name}': ${err}`))
  }

  move (coords) {
    this.storePosition = coords

    try {
      if (this.cam.activeSources) { // If the camera is connected
        this.cam.absoluteMove({
          x: this.calcPan(coords.pan),
          y: this.calcTilt(coords.tilt),
          zoom: this.calcZoom(coords.zoom)
        }, (err) => this.logger.warn(`unable to move camera ${this.name}: ${err}`))
      } else {
        this.logger.info(`unable to move offline camera '${this.name}'`)
      }
    } catch (err) {
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
          else this.logger.info(`getStatus of '${this.name}' returned: ${JSON.stringify(res, null, '  ')}`)
        })
      } else {
        this.logger.info(`unable to get status for offline camera '${this.name}'`)
      }
    } catch (err) {
      this.logger.warn(`Cam.getStatus threw an exception getting status for camera ${this.name}: ${err}`)
    }
  }

  saveShortcut (shortcut) {
    this.logger.log(`saving shortcut: { camera: '${this.name}', shortcut: ${JSON.stringify(shortcut)}, coords: ${JSON.stringify(this.data.coords)} }`)
    this.data.shortcuts[shortcut] = JSON.parse(JSON.stringify(this.data.coords)) // deep copy
    this.storedShortcuts = this.data.shortcuts
  }

  deleteShortcut (shortcut) {
    this.logger.log(`deleting shortcut: { camera: '${this.name}', shortcut: ${shortcut}, coords: ${JSON.stringify(this.data.shortcuts[shortcut])} }`)
    delete this.data.shortcuts[shortcut]
    this.storedShortcuts = this.data.shortcuts
  }

  showShortcut (shortcut) {
    if (shortcut === '*') {
      this.logger.info(`show all: { camera: '${this.name}', shortcuts: ${JSON.stringify(this.data.shortcuts, null, '  ')}}`)
    }
    if (this.data.shortcuts[shortcut]) {
      this.logger.info(`show shortcut: { camera: '${this.name}', shortcut: ${shortcut}, coords: ${JSON.stringify(this.data.shortcuts[shortcut])} }`)
    }
  }

  apply (cmd) {
    if (cmd.search(panRegex) >= 0 || cmd.search(tiltRegex) >= 0 || cmd.search(zoomRegex) >= 0) {
      this.logger.debug(`move camera '${this.name}': ${cmd}`)
      this.applyMove(cmd)
    } else if (cmd.search(/[a-z]+:[\S]+/) >= 0) {
      this.logger.debug(`command camera '${this.name}': ${cmd}`)
      this.applyCommand(cmd)
    } else if (this.data.shortcuts[cmd]) {
      this.logger.debug(`shortcut camera '${this.name}': ${cmd}`)
      this.data.coords = JSON.parse(JSON.stringify(this.data.shortcuts[cmd]))
    } else {
      this.logger.debug(`camera command ignored '${this.name}': ${cmd}`)
    }
  }

  applyCommand (cmd) {
    const [command, shortcut] = cmd.split(/[:]+/)
    if (this.commands.has(command)) this.commands.get(command)(shortcut)
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

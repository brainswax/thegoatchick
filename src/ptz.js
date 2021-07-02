import { Cam } from 'onvif'

export default class PTZ {
  constructor (options) {
    this.name = options.name
    this.version = options.version || 1

    this.logger = options.logger ? options.logger : console

    this.cam = new Cam({
      hostname: options.hostname,
      username: options.username,
      password: options.password
    }, err => {
      if (err) {
        this.logger.error(`Failed to connect to camera '${this.name}': ${err}`)
      } else {
        console.info(`Connected to camera: ${this.name}`) // TODO: use logger once log levels are implemeted
        // this.move(this.data.coords)
      }
    })

    this.data = {
      coords: {
        pan: 240,
        tilt: 20,
        zoom: 50
      },
      shortcuts: {}
    }

    this.pan_regex = /\b(p|pan|right|left|r|l) ?(\+|-)? ?([0-9]{1,3})/gm
    this.tilt_regex = /\b(t|tilt|down|up|d|u) ?(\+|-)? ?([0-9]{1,3})/gm
    this.zoom_regex = /\b(z|zoom|in|out|i|o) ?(\+|-)? ?([0-9]{1,3})/gm

    this.shortcuts_regex = /\b(\w+)\b/gm
  }

  getShortcutList () {
    let shortcuts = ''
    Object.keys(this.data.shortcuts).forEach(item => {
      shortcuts = shortcuts + item + ' '
    })
    return shortcuts
  }

  move (coords) {
    this.cam.absoluteMove({
      x: this.calcPan(coords.pan),
      y: this.calcTilt(coords.tilt),
      zoom: this.calcZoom(coords.zoom)
    })
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
    this.cam.getStatus({}, (err, res) => {
      if (err) this.logger.error(`Error getting camera status for '${this.name}': ${err}`)
      else console.info(JSON.stringify(res, null, 2)) // TODO: use logger once log levels are implemeted
    })
  }

  command (txt) {
    const strLower = txt.toLowerCase()

    // shortcuts
    let matches = strLower.match(this.shortcuts_regex)
    if (matches === null) matches = []

    let first = true
    matches.forEach(match => {
      if (!first && this.data.shortcuts[match]) {
        this.move(this.data.shortcuts[match])
        return
      }
      first = false
    })

    // manual control
    const coords = this.data.coords
    let haveMove = false

    let p = []
    let t = []
    let z = []
    if (strLower.match(this.pan_regex) != null) { p = [...this.pan_regex.exec(strLower)] }
    if (strLower.match(this.tilt_regex) != null) { t = [...this.tilt_regex.exec(strLower)] }
    if (strLower.match(this.zoom_regex) != null) { z = [...this.zoom_regex.exec(strLower)] }

    if (p.length !== 0) {
      coords.pan = this.getVal(p, coords.pan)
      haveMove = true
    }

    if (t.length !== 0) {
      coords.tilt = this.getVal(t, coords.tilt)
      haveMove = true
    }

    if (z.length !== 0) {
      coords.zoom = this.getVal(z, coords.zoom)
      haveMove = true
    }

    if (haveMove) { this.move(coords) }
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
      pos = val
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

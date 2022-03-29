import Herder from './Herder.mjs'

export default class WindowHerder extends Herder {
  constructor (options) {
    super(options)

    this.commands.set('info', (...args) => this.showInfo(...args))
    this.commands.set('i', (...args) => this.showInfo(...args))
    this.commands.set('x', (...args) => this.setXCoord(...args))
    this.commands.set('y', (...args) => this.setYCoord(...args))
    this.commands.set('w', (...args) => this.setWidth(...args))
    this.commands.set('h', (...args) => this.setHeight(...args))
  }

  herd (cmd, str) {
    const split = cmd.split(/\D+/) // Grab the index on the end of the command
    if (split.length > 1) {
      this.command(parseInt(split[1]), str)
    }

    if (this.changed) {
      this.changed = false
      this.obsView.updateOBS()
    }
  }

  showInfo (index, value = '*') {
    if (this.obsView.getWindows().length > index) {
      this.twitch.chat.say(this.twitch.channel, `cam${index} x:${this.obsView.getWindowX(index)} y:${this.obsView.getWindowY(index)} w:${this.obsView.getWindowWidth(index)} h:${this.obsView.getWindowHeight(index)}`)
    }
  }

  setXCoord (index, value) {
    if (!value) return
    const current = this.obsView.getWindowX(index)
    if (value !== current) {
      this.changed = true
      this.obsView.setWindowX(index, parseInt(value))
    }
  }

  setYCoord (index, value) {
    if (!value) return
    const current = this.obsView.getWindowY(index)
    if (value !== current) {
      this.changed = true
      this.obsView.setWindowY(index, parseInt(value))
    }
  }

  setWidth (index, value) {
    if (!value) return
    const current = this.obsView.getWindowWidth(index)
    if (value !== current) {
      this.changed = true
      this.obsView.setWindowWidth(index, parseInt(value))
    }
  }

  setHeight (index, value) {
    if (!value) return
    const current = this.obsView.getWindowHeight(index)
    if (value !== current) {
      this.changed = true
      this.obsView.setWindowHeight(index, parseInt(value))
    }
  }
}

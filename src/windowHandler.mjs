export default class WindowHandler {
  constructor (options) {
    this.logger = options.logger || console
    this.twitch = options.twitch
    this.obsView = options.obsView

    this.commands = new Map()
    this.commands.set('info', (...args) => this.showInfo(...args))
    this.commands.set('i', (...args) => this.showInfo(...args))
    this.commands.set('x', (...args) => this.setXCoord(...args))
    this.commands.set('y', (...args) => this.setYCoord(...args))
    this.commands.set('w', (...args) => this.setWidth(...args))
    this.commands.set('h', (...args) => this.setHeight(...args))
  }

  command (name, txt) {
    const words = txt.trim().toLowerCase()
      .replace(/[a-z]+[\s]+[\d]+/g, (s) => { return s.replace(/[\s]+/, '') }) // replace something like '1 treat' with '1treat'
      .replace(/[a-z][\s]+[+:-]/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces before a colon
      .replace(/[a-z][+:-][\s]+/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces after a colon
      .replace(/[!]+[\S]+[\s]+/, '') // remove the !cam at the beginning
      .split(/[\s]+/) // split on whitespace

    words.forEach(cmd => {
      this.apply(name, cmd)
    })
  }

  apply (name, cmd) {
    if (this.commands.has(cmd)) {
      this.commands.get(cmd)(name)
    }
    else {
      const [command, value] = cmd.split(/[:]+/)
      if (this.commands.has(command)) this.commands.get(command)(chat, channel, name, value)
    }
  }

  handleWindow (cmd, str) {
    let split = cmd.split(/\D+/) // Grab the index on the end of the command
    if (split.length > 1) {
      this.command(split[1], str)
    }
  }

  showInfo (index, value = '*') {
    let windows = this.obsView.getWindows()
    if (windows.length > index) {
      this.twitch.chat.say(this.twitch.channel, `x:${windows[index].position.x}, y:${windows[index].position.y}, w:${windows[index].width}, h:${windows[index].height}`)
    }
  }
}
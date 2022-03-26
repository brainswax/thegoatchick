import Herder from './Herder.mjs'

export default class SceneHerder extends Herder {
  constructor (options) {
    super(options)

    this.commands.set('', (...args) => this.showScenes(...args))
    this.commands.set('info', (...args) => this.showInfo(...args))
    this.commands.set('i', (...args) => this.showInfo(...args))
  }

  herd (cmd, str) {
    this.command(cmd, str)
  }

  showScenes (name, cmd) {
    if (!cmd || cmd.length == 0) this.twitch.chat.say(this.twitch.channel, `scenes: ${this.obsView.getScenes().join(', ')}`)
    else {
      this.obsView.setCurrentScene(cmd)
    }
  }
}
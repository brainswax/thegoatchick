import { GoatDB } from './goatdb.mjs'

export default class OBSView {
  constructor (options) {
    // A map of aliases to camera names
    this.aliases = new Map()
    this.changed = new Set()

    this.obs = options.obs
    this.logger = options.logger || console

    this.db = options.db || new GoatDB({ logger: this.logger })

    this.windowsdb = 'obs.windows' // A unique key to store the object as
    this.db.init()
      .then(() => this.db.fetch(this.windowsdb))
      .then((data) => {
        // Try to get it from the database first. If not, grab it from config.
        if (data) {
          this.logger.info('== loaded OBS windows from the database')
          this.obsWindows = data
        }
      })
      .then(() => {
        if (options.config) { // Not in the database, load from config
          return import(options.config)
            .then(views => {
              if (!this.obsWindows) this.obsWindows = views.default.windows
              this.addAliases(views.default.aliases)
              this.logger.info('== loaded OBS view config from config')
            })
            .catch(err => {
              this.logger.error(`Unable to load OBS aliases: ${err}`)
            })
        }
      })
      .catch(err => this.logger.info(`Unable to retrieve obs views from the database: ${err}`))
  }

  /**
  Takes a chat message and parses it into zero or more set window commands
  @param msg the message from chat
  @return an array of zero or more dictionaries of the format: { index: Number, name: String }
  */
  parseChatCommands (msg) {
    const commands = []
    let n = 0

    const words = msg.toLowerCase()
      .replace(/[!]+[\S]+[\s]+/, '') // remove the !cam at the beginning
      .replace(/[\s]+[\d]+[\s]+[\D]+/g, (s) => { // find instance like: 1 treat
        return ' ' + s.replace(/[\s]+/g, '') // remove the extraneous whitespace: 1treat
      })
      .split(/[\s]+/) // split on whitespace

    words.forEach(word => {
      const i = word.search(/\D/) // Find the first non-digit character
      const camName = word.slice(i) // get everything including and after the first non-digit character
      if (this.aliases.has(camName)) { // Only add a commmand if there are aliases for the camera name
        const camIndex = i === 0 ? 0 : parseInt(word.slice(0, i)) // Assume 0 unless it starts with a number
        if (camIndex < this.obsWindows.length) { // Only add it if there's a camera window available
          commands[n++] = { index: camIndex, name: this.aliases.get(camName) } // Add the command to the array
        }
      }
    })

    return commands
  }

  /**
  Takes a chat message and executes zero or more set window commands and updates OBS
  @param msg the chat message to process
  */
  processChat (msg) {
    this.parseChatCommands(msg).forEach(c => { this.setWindow(c.index, c.name) })
    this.updateOBS()
  }

  /**
  Add a dictionary of camera aliases
  @param allAliases an object with camera names as keys and an array of aliases
  */
  addAliases (allAliases) {
    for (const [cam, aliases] of Object.entries(allAliases)) {
      aliases.forEach(alias => this.aliases.set(alias, cam))
      this.changed.add(cam)
    }
    this.updateOBS()
  }

  setWindow (index, name) {
    let currentIndex = -1
    this.logger.debug(`setWindow({ index: ${index}, name: ${name} })`)

    // get idex of where the view is currently
    for (let x = 0; x < this.obsWindows.length; x++) {
      if (this.obsWindows[x].item === name) currentIndex = x
    }

    if (index !== currentIndex) { // It's either not in a window or we're moving it to a different one
      if (currentIndex > -1) { // It's already displayed in a window
        // Set the current window to whatever it's replacing
        const swap = this.obsWindows[index].item
        this.changed.add(swap)
        this.obsWindows[currentIndex].item = swap
      } else { // It's replacing, so let's disable the replaced camera
        this.changed.add(this.obsWindows[index].item)
      }

      this.obsWindows[index].item = name
      this.changed.add(name)
    }
  }

  /**
  Update OBS with only the cameras that have changed
  */
  updateOBS () {
    if (this.changed.length === 0) {
      this.logger.debug('no OBS views were changed')
    } else {
      this.logger.debug(`updating OBS views...\nchanged: ${JSON.stringify(Array.from(this.changed))}\nobsWindows: ${JSON.stringify(this.obsWindows, null, '  ')}`)
    }

    this.obsWindows.forEach(view => {
      if (this.changed.has(view.item)) {
        this.obs.send('SetSceneItemProperties', view)
          .catch(err => { this.logger.warn(`unable to update OBS view '${view.item}': ${JSON.stringify(err, null, '  ')}`) })
        this.changed.delete(view.item)
      }
    })

    // Anything left needs to be hidden
    this.changed.forEach((cam) => {
      const view = { item: cam, visible: false }
      this.obs.send('SetSceneItemProperties', view)
        .catch(err => { this.logger.warn(`unable to hide OBS view '${cam}': ${JSON.stringify(err, null, '  ')}`) })
    })

    this.changed.clear()
    this.db.store(this.windowsdb, this.obsWindows)
  }

  // TODO: implement
  cameraTimeout (user) {
    return false
  }
}

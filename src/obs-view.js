export default class OBSView {
  constructor (options) {
    // A map of aliases to camera names
    this.aliases = new Map()
    this.changed = new Set()

    this.obs = options.obs
    this.logger = options.logger ? options.logger : console

    if (options.config) {
      import(options.config)
        .then(views => {
          this.obsWindows = views.default.windows
          this.addAliases(views.default.aliases)
          this.logger.info('== loaded OBS view config')
        })
        .catch(err => {
          this.logger.error(`Unable to load OBS aliases: ${err}`)
        })
    }
  }

  /**
  Takes a chat message and parses it into zero or more set window commands
  @param msg the message from chat
  @return an array of zero or more dictionaries of the format: { index: Number, name: String }
  */
  parseChatCommands (msg) {
    const commands = []
    let first = true
    let n = 0

    const words = msg.split(/[\s]+/) // split on whitespace
    words.forEach(word => {
      if (first) { first = false; return } // ignore the !cam at the beginning

      const i = word.search(/[A-Za-z_-]/) // Find the first non-digit character
      const camName = word.slice(i) // get everything including and after the first non-digit character
      if (this.aliases.has(camName)) { // Only add a commmand if there are aliases for the camera name
        const camIndex = i === 0 ? 0 : parseInt(word.slice(0, i)) // Assume 0 unless it starts with a number
        if (camIndex < this.obsWindows.length) { // Only add it if there's a camera window available
          commands[n++] = { index: camIndex, name: camName } // Add the command to the array
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
    this.parseChatCommands(msg).forEach(c => { this.setWindow(c.index, this.aliases.get(c.name)) })
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
    console.debug(`[${new Date().toISOString()}] Debug: setWindow({ index: ${index}, name: ${name} })`)

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
      console.debug(`[${new Date().toISOString()}] Debug: no OBS views were changed`)
    } else {
      console.debug(`[${new Date().toISOString()}] Debug: updating OBS views...\nchanged: ${JSON.stringify(Array.from(this.changed))}\nobsWindows: ${JSON.stringify(this.obsWindows, null, '  ')}`)
    }

    this.obsWindows.forEach(view => {
      if (this.changed.has(view.item)) {
        this.obs.send('SetSceneItemProperties', view)
          .catch(err => { console.error(`[${new Date().toISOString()}] Error: unable to update OBS view '${view.item}': ${JSON.stringify(err, null, '  ')}`) })
        this.changed.delete(view.item)
      }
    })

    // Anything left needs to be hidden
    this.changed.forEach((cam) => {
      const view = { item: cam, visible: false }
      this.obs.send('SetSceneItemProperties', view)
        .catch(err => { console.error(`[${new Date().toISOString()}] Error: unable to hide OBS view '${cam}': ${JSON.stringify(err, null, '  ')}`) })
    })

    this.changed.clear()
  }

  // TODO: implement
  cameraTimeout (user) {
    return false
  }
}

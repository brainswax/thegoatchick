import { Stojo } from '@codegrill/stojo'

export default class OBSView {
  constructor (options) {
    // A map of aliases to camera names
    this.aliases = new Map()
    this.changed = new Set()

    this.obs = options.obs
    this.logger = options.logger || console

    this.db = options.db || new Stojo({ logger: this.logger })
    this.scenes = {}

    this.storedWindows // Grab the previous window settings if they exist
      .then(windows => {
        this.obsWindows = windows
        return import(options.config || process.env.OBS_VIEWS_CONFIG)
      })
      .then(views => {
        if (!this.obsWindows) this.obsWindows = views.default.windows
        this.logger.debug(`initial windows: ${JSON.stringify(this.obsWindows, null, '  ')}`)
      })
      .catch(err => this.logger.error(`initializing windows: ${err}`))
  }

  /**
  This function is used to correct windows object structure that has changed between versions of this software
  */
  fixupWindows (views) {
    // Nothing to fixup
    return views
  }

  /**
  Gets the key for storing windows
  */
  get windowskey () {
    return 'obs.windows'
  }

  get storedWindows () {
    return this.db.fetch(this.windowskey)
      .then(views => {
        if (views) this.logger.info(`loaded the windows: ${JSON.stringify(views)}`)
        return this.fixupWindows(views)
      })
      .catch(err => this.logger.warn(`loading the camera position for '${this.name}': ${err}`))
  }

  set storedWindows (views) {
    this.logger.debug(`store the views: ${JSON.stringify(views)}`)
    this.db.store(this.windowskey, views)
      .catch(err => this.logger.warn(`storing the views: ${err}`))
  }

  /**
  Takes a chat message and parses it into zero or more set window commands
  @param msg the message from chat
  @return an array of zero or more dictionaries of the format: { index: Number, name: String }
  */
  parseChatCommands (msg) {
    const commands = []
    let n = 0

    const words = msg.trim().toLowerCase()
      .replace(/[\d]+[\s]+[\D]+/g, (s) => { return s.replace(/[\s]+/, '') }) // replace something like '1 treat' with '1treat'
      .replace(/[a-z][\s]+[:]/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces before a colon
      .replace(/[a-z][:][\s]+/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces after a colon
      .replace(/[!]+[\S]+[\s]+/, '') // remove the !cam at the beginning
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
  Determine whether the specified camera is currnetly in view
  @param camera the camera name
  @return true if the camera is currently shown in a window
  */
  inView (camera) {
    let inview = false
    if (this.aliases.has(camera)) {
      this.obsWindows.forEach((w) => { inview |= this.aliases.get(camera) === w.item })
    }

    return inview
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
   * Given an obs connection, grab all the scenes and resources to construct the cams and windows
   */
  async syncFromObs() {
    return this.obs.send('GetSceneList')
      .then(async data => {
        this.scenes = {}
        this.currentScene = data['current-scene']

        // Grab all the scenes from OBS
        this.logger.debug(`OBS: GetSceneList: ${JSON.stringify(data)}`)
        this.logger.info(`OBS scenes: ${JSON.stringify(data.scenes)}`)

        // For each scene, request the properties for each source
        await Promise.all(data.scenes.map(async scene => {
          this.scenes[scene.name] = { name: scene.name }
          this.scenes[scene.name].sources = {}
          this.scenes[scene.name].types = {}
          this.scenes[scene.name].windows = []

          await Promise.all(scene.sources.map(async source => {
            // Get the type such as an image or video source
            scene.sources.forEach(source => this.scenes[scene.name].types[source.name] = source.type)
            
            // Request properties for each source
            await this.obs.send('GetSceneItemProperties', {scene: scene.name, item: source.name})
              .then(async s => {
                this.scenes[scene.name].sources[source.name] = s

                if (s.visible /* && this.scenes[scene.name].types[scene.name] == 'dshow_input'*/) {
                  this.scenes[scene.name].windows.push({
                    item: s.name,
                    position: s.position,
                    scale: s.scale,
                    visible: true
                  })
                }
              })
              .catch(e => this.logger.error(`Error getting scene properties: scene: ${scene}, item: ${source.name}`))
          }))

          // Sort the windows based on their position on the screen to get cam0, cam1, etc.
          this.scenes[scene.name].windows.sort((a, b) => {
            return a.position.x < b.position.x ? -1 : a.position.x > b.position.x ? 1 : a.position.y < b.position.y ? -1 : a.position.y > b.position.y ? 1 : 0
          })
        }))
        .then(() => { // Should move this outside the function
          let aliases = {}
          Object.keys(this.scenes).forEach(scene => {
            Object.keys(this.scenes[scene].types).map(source => aliases[source] = [source.toLowerCase()])
          })
          this.addAliases(aliases)
        })
        .then(() => {
          this.logger.info(`this.scenes: ${JSON.stringify(this.scenes, null, 2)}`)
        })
      })
  }

  /**
  Update OBS with only the cameras that have changed
  */
  updateOBS () {
    if (this.changed.length === 0) {
      this.logger.debug('no OBS views were changed')
    } else {
      this.logger.info(`changed windows: ${JSON.stringify(Array.from(this.changed))}`)
      this.logger.debug(`updated windows: ${JSON.stringify(this.obsWindows, null, '  ')}`)
    }

    this.obsWindows.forEach(view => {
      if (this.changed.has(view.item)) {
        this.obs.send('SetSceneItemProperties', view)
          .then(() => this.changed.delete(view.item))
          .catch(err => { this.logger.warn(`unable to update OBS view '${view.item}': ${err.error}`) })
        this.changed.delete(view.item)
      }
    })

    // Anything left needs to be hidden
    this.changed.forEach((cam) => {
      const view = { item: cam, visible: false }
      this.obs.send('SetSceneItemProperties', view)
        .then(() => this.changed.delete(view.item))
        .catch(err => { this.logger.warn(`unable to hide OBS view '${cam}': ${err.error}`) })
    })

    if (this.changed.size > 0 & process.env.OBS_RETRY !== 'false') { // Something didn't update, let's try again later
      setTimeout(() => this.updateOBS(), parseInt(process.env.OBS_RETRY_DELAY) || 5000)
    }

    this.storedWindows = this.obsWindows
  }

  // TODO: implement
  cameraTimeout (user) {
    return false
  }
}

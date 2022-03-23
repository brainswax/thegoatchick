import { Stojo } from '@codegrill/stojo'

export default class OBSView {
  constructor (options) {
    this.obs = options.obs
    this.logger = options.logger || console
    this.windowTypes = options.windowTypes || ['dshow_input']

    this.db = options.db || new Stojo({ logger: this.logger })
    this.scenes = {}
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

  commandWindows (chat, channel, message) {
    this.logger.debug(`OBS Sources: ${JSON.stringify(this.scenes[this.currentScene].sources, null, 2)}`)
    this.logger.debug(`Filtered sources: ${JSON.stringify(this.getSources(this.windowTypes), null, 2)}`)
    this.logger.debug(`Windows: ${JSON.stringify(this.scenes[this.currentScene].windows, null, 2)}`)
    chat.say(channel, `There are ${this.scenes[this.currentScene].windows.length} windows.`)
  }

  /**
   * Gets an array of OBS sources by type
   * @param types the OBS source type
   * @returns array of source names
  */
  getSources (types) {
    const sources = []

    if (this.currentScene && this.scenes[this.currentScene]) {
      Object.values(this.scenes[this.currentScene].sources).forEach(source => {
        if (!types || types.includes(source.type)) {  // If types is null, assume any type
          sources.push(source.name.toLowerCase())
        }
      })
    }

    return sources
  }

  /**
  Takes a chat message and parses it into zero or more set window commands
  @param msg the message from chat
  @return an array of zero or more dictionaries of the format: { index: Number, name: String }
  */
  parseChatCommands (msg) {
    const commands = []

    if (this.currentScene && this.scenes[this.currentScene]) { // Only if we've loaded from OBS
      const words = msg.trim().toLowerCase()
        .replace(/[\d]+[\s]+[\D]+/g, (s) => { return s.replace(/[\s]+/, '') }) // replace something like '1 treat' with '1treat'
        .replace(/[a-z][\s]+[:]/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces before a colon
        .replace(/[a-z][:][\s]+/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces after a colon
        .replace(/[!]+[\S]+[\s]+/, '') // remove the !cam at the beginning
        .split(/[\s]+/) // split on whitespace

      let n = 0
      words.forEach(word => {
        const i = word.search(/\D/) // Find the first non-digit character
        const camName = word.slice(i) // get everything including and after the first non-digit character
        if (camName in this.scenes[this.currentScene].aliases) { // Only add a commmand if there are aliases for the camera name
          const camIndex = i === 0 ? 0 : parseInt(word.slice(0, i)) // Assume 0 unless it starts with a number
          if (camIndex < this.scenes[this.currentScene].cams.length) { // Only add it if there's a camera window available
            commands[n++] = { index: camIndex, name: this.scenes[this.currentScene].aliases[camName] } // Add the command to the array
          }
        }
      })
    }

    return commands
  }

  /**
  Takes a chat message and executes zero or more set window commands and updates OBS
  @param msg the chat message to process
  */
  processChat (msg) {
    if (this.currentScene && this.scenes[this.currentScene]) {
      this.parseChatCommands(msg).forEach(c => { this.setWindow(c.index, c.name) })
      this.updateOBS()
    } else {
      this.logger.warn('Chat command cannot be processed because OBS has not been loaded yet')
    }
  }

  /**
  Determine whether the specified camera is currnetly in view
  @param camera the camera name
  @return true if the camera is currently shown in a window
  */
  inView (cam) {
    return this.currentScene && this.scenes[this.currentScene] && cam in this.scenes[this.currentScene].cams
  }

  setWindow (index, name) {
    if (this.currentScene && this.scenes[this.currentScene]) {
      let currentIndex = -1
      this.logger.debug(`setWindow({ index: ${index}, name: ${name} }), current scene: ${this.currentScene}`)

      try {
        // get index of where the view is currently
        for (let x = 0; x < this.scenes[this.currentScene].cams.length; x++) {
          if (this.scenes[this.currentScene].cams[x] === name) currentIndex = x
        }

        if (index !== currentIndex) { // It's either not in a window or we're moving it to a different one
          if (currentIndex > -1) { // It's already displayed in a window
            // Set the current window to whatever it's replacing
            const swap = this.scenes[this.currentScene].cams[index]
            this.scenes[this.currentScene].changed.add(swap)
            this.scenes[this.currentScene].cams[currentIndex] = swap
          } else { // It's replacing, so let's disable the replaced camera
            this.scenes[this.currentScene].changed.add(this.scenes[this.currentScene].cams[index])
          }

          this.scenes[this.currentScene].cams[index] = name
          this.scenes[this.currentScene].changed.add(name)
        }
      } catch (e) { this.logger.error(`Error setting window: ${JSON.stringify(e)}`) }
    }
  }

  /**
   * Given an obs connection, grab all the scenes and resources to construct the cams and windows
   */
  async syncFromObs () {
    // Grab all the scenes from OBS
    return this.obs.send('GetSceneList')
      .then(async data => {
        this.scenes = {}
        this.currentScene = data['current-scene']

        this.logger.info(`Current OBS scene: '${this.currentScene}'`)

        // For each scene, request the properties for each source
        await Promise.all(data.scenes.map(async scene => {
          this.scenes[scene.name] = {
            name: scene.name,
            sources: {},
            aliases: {},
            windows: [],
            changed: new Set(),
            cams: []
          }

          if (scene.name === this.currentScene) { // TODO: grab all the scenes
            await Promise.all(scene.sources.map(async source => {
              // Automatically add an alias
              this.scenes[scene.name].aliases[source.name.toLowerCase().replace(' ', '-')] = source.name

              // Request properties for each source
              await this.obs.send('GetSceneItemProperties', { scene: scene.name, item: source.name })
                .then(async s => {
                  this.scenes[scene.name].sources[source.name] = s
                  this.scenes[scene.name].sources[source.name].source_cx = source.source_cx
                  this.scenes[scene.name].sources[source.name].source_cy = source.source_cy
                  this.scenes[scene.name].sources[source.name].type = source.type

                  if (s.visible && this.windowTypes.includes(s.type)) { // Only visible media sources are treated as windows
                    this.scenes[scene.name].windows.push({
                      source: s.name,
                      position: s.position,
                      width: s.width,
                      height: s.height
                    })
                  }
                })
                .catch(e => this.logger.error(`Error getting scene properties: scene: ${scene}, source: ${source.name}`))
            }))

            // Sort the windows based on their position on the screen to get cam0, cam1, etc.
            this.scenes[scene.name].windows.sort((a, b) => {
              if (a.width * a.height > b.width * b.height) return -1 // Window 'a' is bigger
              else if (a.width * a.height < b.width * b.height) return 1 // Window 'b' is bigger
              else { // The windows are the same size, sort by distance from the origin
                const adist = Math.sqrt(a.position.x ** 2 + a.position.y ** 2)
                const bdist = Math.sqrt(b.position.x ** 2 + b.position.y ** 2)
                if (adist < bdist) return -1 // Window 'a' is closer to the top left
                else if (adist < bdist) return 1 // Window 'b' is closer to the top left
                else if (a.position.x < b.position.x) return -1 // Window 'a' is closer to the left
                else if (a.position.x > b.position.x) return 1 // Window 'b' is closer to the left
                else if (a.position.y < b.position.y) return -1 // Window 'a' is closer to the top
                else if (a.position.y > b.position.y) return 1 // Window 'a' is closer to the left
              }

              return 0 // The windows are the same size and position
            })

            this.scenes[scene.name].cams = this.scenes[scene.name].windows.map(w => w.source)
            this.updateWindows(scene.name)
          }
        }))
          .then(() => {
            this.logger.info(`Loaded OBS scenes: '${Object.keys(this.scenes).join('\', \'')}'`)
            this.logger.debug(`OBS Scenes: ${JSON.stringify(this.scenes, null, 2)}`)
          })
      })
  }

  updateWindows (scene) {
    const windows = []

    if (scene && this.scenes[scene]) {
      try {
        let i = 0
        this.scenes[scene].windows.forEach(window => {
          const name = this.scenes[scene].cams[i++]
          windows.push({
            item: name,
            position: window.position,
            scale: {
              filter: this.scenes[scene].sources[name].scale.filter || 'OBS_SCALE_DISABLE',
              x: window.width / this.scenes[scene].sources[name].source_cx,
              y: window.height / this.scenes[scene].sources[name].source_cy
            },
            visible: true
          })
        })
      } catch (e) { this.logger.error(`Error updating windows: ${JSON.stringify(e)}`) }
    }

    return windows
  }

  /**
  Update OBS with only the cameras that have changed
  */
  updateOBS () {
    if (this.currentScene) {
      const windows = this.updateWindows(this.currentScene)

      if (this.scenes[this.currentScene].changed.length === 0) {
        this.logger.debug('no OBS views were changed')
      } else {
        this.logger.info(`changed windows: ${JSON.stringify(Array.from(this.scenes[this.currentScene].changed))}`)
        this.logger.debug(`updated windows: ${JSON.stringify(windows, null, '  ')}`)
      }

      windows.forEach(window => {
        if (this.scenes[this.currentScene].changed.has(window.item)) {
          this.obs.send('SetSceneItemProperties', window)
            .then(() => this.scenes[this.currentScene].changed.delete(window.item))
            .catch(err => { this.logger.warn(`Unable to set OBS properties '${window.item}' for scene '${this.currentScene}': ${JSON.stringify(err)}`) })
        }
      })

      // Anything left needs to be hidden
      this.scenes[this.currentScene].changed.forEach(cam => {
        if (!this.scenes[this.currentScene].cams.includes(cam)) {
          const view = { source: cam, render: false }
          view['scene-name'] = this.currentScene
          this.obs.send('SetSceneItemRender', view)
            .then(() => this.scenes[this.currentScene].changed.delete(cam))
            .catch(err => { this.logger.warn(`Unable to hide OBS view '${cam}' for scene '${this.currentScene}': ${err.error}`) })
        }
      })

      if (this.scenes[this.currentScene].changed.size > 0 & process.env.OBS_RETRY !== 'false') { // Something didn't update, let's try again later
        setTimeout(() => this.updateOBS(), parseInt(process.env.OBS_RETRY_DELAY) || 5000)
      }

      this.storedWindows = windows
    }
  }

  // TODO: implement the ability to timeout a user for abusing the cams
  cameraTimeout (user) {
    return false
  }
}

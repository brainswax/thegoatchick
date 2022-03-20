import { Stojo } from '@codegrill/stojo'

export default class OBSView {
  constructor (options) {
    this.obs = options.obs
    this.logger = options.logger || console

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
      if (camName in this.scenes[this.currentScene].aliases) { // Only add a commmand if there are aliases for the camera name
        const camIndex = i === 0 ? 0 : parseInt(word.slice(0, i)) // Assume 0 unless it starts with a number
        if (camIndex < this.scenes[this.currentScene].cams.length) { // Only add it if there's a camera window available
          commands[n++] = { index: camIndex, name: this.scenes[this.currentScene].aliases[camName] } // Add the command to the array
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
  inView (cam) {
    return cam in this.scenes[this.currentScene].cams
  }

  setWindow (index, name) {
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

  /**
   * Given an obs connection, grab all the scenes and resources to construct the cams and windows
   */
  async syncFromObs () {
    // Grab all the scenes from OBS
    return this.obs.send('GetSceneList')
      .then(async data => {
        this.scenes = {}
        this.currentScene = data['current-scene']

        this.logger.info(`Current OBS scene: '${this.currentScene}`)
        this.logger.debug(`OBS: GetSceneList: ${JSON.stringify(data, null, 2)}`)

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

                  if (s.visible) {
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
              return a.position.x < b.position.x ? -1 : a.position.x > b.position.x ? 1 : a.position.y < b.position.y ? -1 : a.position.y > b.position.y ? 1 : 0
            })

            this.scenes[scene.name].cams = this.scenes[scene.name].windows.map(w => w.source)
            this.updateWindows(scene.name)
          }
        }))
          .then(() => {
            this.logger.debug(`OBS Scenes: ${JSON.stringify(this.scenes, null, 2)}`)
          })
      })
  }

  updateWindows (scene) {
    const windows = []

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
    } catch (e) { this.logger.error(`Error updating NEW windows: ${JSON.stringify(e)}`) }

    return windows
  }

  /**
  Update OBS with only the cameras that have changed
  */
  updateOBS () {
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
          .catch(err => { this.logger.warn(`unable to update OBS view '${window.item}': ${err.error}`) })
      }
    })

    // Anything left needs to be hidden
    this.scenes[this.currentScene].changed.forEach(cam => {
      const view = { item: cam, visible: false }
      if (!cam in this.scenes[this.currentScene].cams) {
        this.obs.send('SetSceneItemProperties', view)
          .then(() => this.scenes[this.currentScene].changed.delete(view.item))
          .catch(err => { this.logger.warn(`unable to hide OBS view '${cam}': ${err.error}`) })
      }
    })

    if (this.scenes[this.currentScene].changed.size > 0 & process.env.OBS_RETRY !== 'false') { // Something didn't update, let's try again later
      setTimeout(() => this.updateOBS(), parseInt(process.env.OBS_RETRY_DELAY) || 5000)
    }

    this.storedWindows = windows
  }

  // TODO: implement the ability to timeout a user for abusing the cams
  cameraTimeout (user) {
    return false
  }
}

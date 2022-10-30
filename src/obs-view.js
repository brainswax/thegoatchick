import { Stojo } from '@codegrill/stojo'

function sortWindows (a, b) {
  const fudge = process.env.CAM_FUDGE ? +(process.env.CAM_FUDGE) : 0.8
  if (a.width * a.height * fudge > b.width * b.height) return -1 // Window 'a' is bigger
  else if (a.width * a.height < b.width * b.height * fudge) return 1 // Window 'b' is bigger
  else { // The windows are the same size, sort by distance from the origin
    const adist = Math.sqrt((a.x * 9 / 16) ** 2 + a.y ** 2) // Make it square, then find the distance
    const bdist = Math.sqrt((b.x * 9 / 16) ** 2 + b.y ** 2) // Make it square, then find the distance
    if (adist < bdist) return -1 // Window 'a' is closer to the origin
    else if (adist > bdist) return 1 // Window 'b' is closer to the origin
    else if (a.x < b.x) return -1 // Window 'a' is closer to the left
    else if (a.x > b.x) return 1 // Window 'b' is closer to the left
    else if (a.y < b.y) return -1 // Window 'a' is closer to the top
    else if (a.y > b.y) return 1 // Window 'b' is closer to the top
  }

  return 0 // The windows are the same size and position
}

function getSceneAliases (scenes) {
  const sceneAliases = {} // Needs to be an Object, not Map, in order to persist it in the object store
  for (const sceneName in scenes) sceneAliases[sceneName.toLowerCase().replace(/\W/g, '-')] = sceneName
  return sceneAliases
}

function getSourceAliases (sources) {
  const sourceAliases = {} // Needs to be an Object, not Map, in order to persist it in the object store
  for (const sceneItemId in sources) sourceAliases[sources[sceneItemId].sourceName.toLowerCase().replace(/\W/g, '-')] = parseInt(sceneItemId)
  return sourceAliases
}

function getSceneCams (windows) {
  const cams = []
  windows.forEach(window => cams.push(window.sceneItemId))
  return cams
}

function getSceneWindows (scene, windowKinds) {
  const windows = []
  for (const sceneItemId in scene.sources) {
    const source = scene.sources[sceneItemId]

    if (source.sceneItemEnabled && windowKinds.includes(source.inputKind)) { // Only visible media sources are treated as windows
      windows.push({
        sceneItemId: source.sceneItemId,
        x: source.sceneItemTransform.positionX,
        y: source.sceneItemTransform.positionY,
        width: source.sceneItemTransform.width,
        height: source.sceneItemTransform.height
      })
    }
  }

  return windows
}

function getWindowsFromScene (scene) {
  const windows = []

  if (scene && scene.windows) {
    let i = 0
    scene.windows.forEach(window => {
      if (scene.cams && scene.cams.length > i) {
        const sceneItemId = scene.cams[i++]

        windows.push({
          sceneName: scene.sceneName,
          sceneItemId: sceneItemId,
          sceneItemTransform: {
            positionX: window.x,
            positionY: window.y,
            boundsType: 'OBS_BOUNDS_STRETCH',
            boundsWidth: window.width,
            boundsHeight: window.height
          }
        })
      }
    })
  }

  return windows
}

class ScenesRenderer {
  constructor (options) {
    this.obs = options.obs
    this.logger = options.logger
  }

  async getSceneItemList (sceneName) {
    return this.obs.call('GetSceneItemList', { sceneName: sceneName })
  }

  async getSceneSources (sceneName) {
    const sources = {}
    return this.getSceneItemList(sceneName)
      .then(sourceList => {
        sourceList.sceneItems.forEach(source => {
          sources[source.sceneItemId] = source
        })

        return sources
      })
  }

  async getScene (sceneName) {
    const scene = {
      sceneName: sceneName,
      changedCams: new Set(),
      changedWindows: new Set()
    }

    return this.getSceneSources(sceneName)
      .then(sources => {
        scene.sources = sources
        scene.sourceAliases = getSourceAliases(sources)
        return scene
      })
  }

  async getScenes (scenesData, windowKinds) {
    const scenes = {}
    return Promise.all(scenesData.map(async sceneData => {
      return this.getScene(sceneData.sceneName)
        .then(scene => {
          scene.sceneIndex = sceneData.sceneIndex
          scene.windows = getSceneWindows(scene, windowKinds)
          scene.windows.sort((a, b) => sortWindows(a, b)) // Sort the windows for cam0, cam1, etc.
          scene.cams = getSceneCams(scene.windows) // Depends on the order of the windows
          scene.windows.forEach(window => { if (window.sceneItemId) delete window.sceneItemId }) // Don't need the name now that we have sorted the windows
          scenes[scene.sceneName] = scene
        })
    }))
      .then(() => scenes)
  }
}

export default class OBSView {
  constructor (options) {
    this.obs = options.obs
    this.logger = options.logger || console
    this.windowKinds = options.windowKinds || ['dshow_input', 'ffmpeg_source']

    this.db = options.db || new Stojo({ logger: this.logger })
    this.scenesRenderer = new ScenesRenderer({ obs: this.obs, logger: this.logger })
    this.scenes = {}
    this.sceneAliases = {}
    this.currentScene = ''

    this.commands = new Map()
    this.commands.set('source', (...args) => this.handleShowInfo(...args))
    this.commands.set('show', (...args) => this.handleShowSource(...args))
    this.commands.set('hide', (...args) => this.handleHideSource(...args))
    this.commands.set('reset', (...args) => this.handleResetSource(...args))
    this.commands.set('mute', (...args) => this.handleMuteSource(...args))
    this.commands.set('unmute', (...args) => this.handleUnmuteSource(...args))
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
        if (views) this.logger.debug(`loaded the windows: ${JSON.stringify(views)}`)
        return this.fixupWindows(views)
      })
      .catch(err => this.logger.warn(`loading the camera position for '${this.name}': ${err}`))
  }

  set storedWindows (views) {
    this.logger.debug(`store the views: ${JSON.stringify(views)}`)
    this.db.store(this.windowskey, views)
      .catch(err => this.logger.warn(`storing the views: ${err}`))
  }

  command (chat, channel, alias, txt) {
    const words = txt.trim().toLowerCase()
      .replace(/[a-z]+[\s]+[\d]+/g, (s) => { return s.replace(/[\s]+/, '') }) // replace something like '1 treat' with '1treat'
      .replace(/[a-z][\s]+[+:-]/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces before a colon
      .replace(/[a-z][+:-][\s]+/g, (s) => { return s.replace(/[\s]+/g, '') }) // remove spaces after a colon
      .replace(/[!]+[\S]+[\s]+/, '') // remove the !cam at the beginning
      .split(/[\s]+/) // split on whitespace

    words.forEach(cmd => {
      this.apply(chat, channel, alias, cmd)
    })
  }

  apply (chat, channel, alias, cmd) {
    if (this.commands.has(cmd)) {
      this.commands.get(cmd)(chat, channel, alias)
    } else {
      const [command, value] = cmd.split(/[:]+/)
      if (this.commands.has(command)) {
        this.commands.get(command)(chat, channel, alias, value)
          .catch(e => { this.logger.error(`Error handling command '${command}' for alias '${alias}': ${JSON.stringify(e)}`) })
      }
    }
  }

  async handleShowInfo (chat, channel, alias, value) {
    const source = this.getSourceByAlias(alias)
    if (source) {
      chat.say(channel, `${alias} source w:${source.sceneItemTransform.sourceWidth} h:${source.sceneItemTransform.sourceHeight}`)
    } else {
      this.logger.info(`No source info for '${alias}'`)
    }
  }

  async setSceneItemEnabled (sceneItemId, sceneName, enabled = true) {
    const item = {
      sceneName: sceneName,
      sceneItemId: sceneItemId,
      sceneItemEnabled: enabled
    }
    return this.obs.call('SetSceneItemEnabled', item)
      .catch(e => {
        this.logger.warn(`Unable to ${enabled ? 'show' : 'hide'} source '${this.getNameBySourceId(sceneItemId, sceneName)}' in scene '${sceneItemId}': ${e.error}`)
      })
  }

  async handleShowSource (chat, channel, alias, show) {
    return this.setSceneItemEnabled(
      this.getSourceIdByAlias(alias, this.currentScene),
      this.currentScene,
      show !== 'false')
  }

  async handleHideSource (chat, channel, alias, hide) {
    return this.setSceneItemEnabled(
      this.getSourceIdByAlias(alias, this.currentScene),
      this.currentScene,
      hide === 'false')
  }

  async handleResetSource (chat, channel, alias, value) {
    const sceneItemId = this.getSourceIdByAlias(alias)

    if (this.scenes[this.currentScene].sources[sceneItemId].sceneItemEnabled) {
      return this.resetSource(sceneItemId, this.currentScene, value && parseInt(parseFloat(value) * 1000))
    }
  }

  async handleMuteSource (chat, channel, alias, value) {
    const sceneItemId = this.getSourceIdByAlias(alias, this.currentScene)
    return sceneItemId && this.muteSource(sceneItemId, this.currentScene, value === 'true')
  }

  async handleUnmuteSource (chat, channel, alias, value) {
    const sceneItemId = this.getSourceIdByAlias(alias, this.currentScene)
    return sceneItemId && this.muteSource(sceneItemId. this.currentScene, value === 'false')
  }

  async muteSource (sceneItemId, sceneName, mute) {
    this.logger.log(`TODO: mute/unmute camera '${this.scenes[sceneName].sources[sceneItemId].sourceName}' for scene '${sceneName}'`)
  }

  async resetSource (sceneItemId, sceneName, delay) {
    const sourceName = this.scenes[sceneName].sources[sceneItemId].sourceName
    this.setSceneItemEnabled(sceneItemId, sceneName, false) // hide
      .then(() => {
        setTimeout(() => this.setSceneItemEnabled(sceneItemId, sceneName, true) // show
          .then(() => { this.logger.info(`Reset source '${sourceName}' in scene '${sceneName}'`) })
          .catch(e => { this.logger.error(`Unable to show source '${sourceName}' in scene '${sceneName}' for reset: ${e.message}`) }),
        delay || process.env.RESET_SOURCE_DELAY || 3000)
      })
      .catch(e => { this.logger.error(`Unable to hide source '${sourceName}' in scene '${sceneName}' for reset: ${e.message}`) })
  }

  commandWindows (chat, channel, message) {
    this.logger.debug(`OBS Sources: ${JSON.stringify(this.scenes[this.currentScene].sources, null, 2)}`)
    this.logger.debug(`Filtered sources: ${JSON.stringify(this.getSources(this.windowKinds), null, 2)}`)
    this.logger.debug(`Windows: ${JSON.stringify(this.scenes[this.currentScene].windows, null, 2)}`)
    if (this.scenes[this.currentScene].windows.length === 0) chat.say(channel, 'There are currenly no windows displayed')
    else {
      const windows = []
      for (let i = 0; i < this.scenes[this.currentScene].windows.length; i++) {
        const sceneItemId = this.scenes[this.currentScene].cams[i]
        windows.push(`${i}:${this.scenes[this.currentScene].sources[sceneItemId].sourceName}`)
      }
      chat.say(channel, `Windows: ${windows.join(', ')}`)
    }
  }

  /**
   * Gets an array of OBS sources by kind
   * @param kinds the OBS source kind
   * @returns array of source names
  */
  getSources (kinds) {
    const sources = []

    if (this.currentScene && this.scenes[this.currentScene]) {
      Object.values(this.scenes[this.currentScene].sources).forEach(source => {
        if (!kinds || kinds.includes(source.inputKind)) { // If kinds is null, assume any kind
          sources.push(source.sourceName.toLowerCase())
        }
      })
    }

    return sources
  }

  /**
   * Get the source object by alias name
   * @param {string} sourceAlias an alias for the source
   * @param {string} sceneName the name of the scene
   * @returns the source objevt returned from OBS
   */
  getSourceByAlias (sourceAlias, sceneName) {
    sceneName = sceneName || this.currentScene
    if (this.scenes[sceneName]) {
      const sceneItemId = this.scenes[sceneName].sourceAliases[sourceAlias]
      if (sceneItemId) {
        return this.scenes[sceneName].sources[sceneItemId]
      }
    }
  }

  getSourceById (sceneItemId, sceneName) {
    sceneName = sceneName || this.currentScene
    return this.scenes[sceneName] && this.scenes[sceneName].sources[sceneItemId]
  }

  getSourceIdByAlias (sourceAlias, sceneName) {
    sceneName = sceneName || this.currentScene
    if (this.scenes[sceneName]) {
      return this.scenes[sceneName].sourceAliases[sourceAlias]
    }
  }

  getSourceIdByName (sourceName, sceneName) {
    sceneName = sceneName || this.currentScene
    if (this.scenes[sceneName]) {
      for (const sceneItemId in this.scenes[sceneName].sources) {
        if (this.scenes[sceneName].sources[sceneItemId].sourceName === sourceName) {
          return sceneItemId
        }
      }
    }
  }

  getNameBySourceId (sceneItemId, sceneName) {
    sceneName = sceneName || this.currentScene

    return sceneItemId && this.scenes[sceneName] && this.scenes[sceneName].sources[sceneItemId]
  }

  hasSourceAlias (sourceAlias, sceneName) {
    sceneName = sceneName || this.currentScene
    return this.scenes[sceneName] && sourceAlias in this.scenes[sceneName].sourceAliases
  }

  getAliases (sceneName) {
    const scene = this.scenes[sceneName || this.currentScene]
    return scene ? Object.keys(scene.sourceAliases) : null
  }

  getWindows (sceneName) {
    const scene = this.scenes[sceneName || this.currentScene]
    return scene ? scene.windows : null
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
        const camId = this.getSourceIdByAlias(camName, this.currentScene)
        if (camName in this.scenes[this.currentScene].sourceAliases) { // Only add a commmand if there are aliases for the camera name
          const camIndex = i === 0 ? 0 : parseInt(word.slice(0, i)) // Assume 0 unless it starts with a number
          if (camIndex < this.scenes[this.currentScene].cams.length) { // Only add it if there's a camera window available
            commands[n++] = { index: camIndex, id: camId } // Add the command to the array
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
      this.parseChatCommands(msg).forEach(c => { this.setWindow(c.index, c.id) })
      this.updateOBS(this.currentScene)
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

  setWindow (index, camId) {
    if (this.currentScene && this.scenes[this.currentScene]) {
      let currentIndex = -1
      this.logger.info(`Setting cam${index} to '${camId}' for scene '${this.currentScene}'`)

      try {
        // get index of where the specified source is currently
        for (let x = 0; x < this.scenes[this.currentScene].cams.length; x++) {
          if (this.scenes[this.currentScene].cams[x] === camId) {
            currentIndex = x
          }
        }

        if (index !== currentIndex) { // It's either not in a window or we're moving it to a different one
          this.scenes[this.currentScene].changedCams.add(camId)
          if (currentIndex > -1) { // It's already displayed in a window
            // Set the current window to whatever it's replacing
            const swap = this.scenes[this.currentScene].cams[index]
            this.scenes[this.currentScene].changedCams.add(swap)
            this.scenes[this.currentScene].cams[currentIndex] = swap
            this.logger.info(`Swapping cam${currentIndex} with '${swap}' for scene '${this.currentScene}'`)
          } else { // It's replacing, so let's disable the replaced camera
            this.scenes[this.currentScene].changedCams.add(this.scenes[this.currentScene].cams[index])
            this.logger.info(`Source '${this.scenes[this.currentScene].cams[index]}' moved out of scene '${this.currentScene}'`)
          }

          this.scenes[this.currentScene].cams[index] = camId
        }
      } catch (e) { this.logger.error(`Error setting window: ${JSON.stringify(e)}`) }
    }
  }

  getWindowX (index, scene) {
    const sceneName = scene || this.currentScene
    if (this.scenes[sceneName].windows.length > index) return this.scenes[sceneName].windows[index].position.x
  }

  setWindowX (index, value, scene) {
    const sceneName = scene || this.currentScene
    if (this.scenes[sceneName].windows.length > index) {
      const old = this.scenes[sceneName].windows[index].position.x
      if (value !== old) {
        this.scenes[sceneName].changedWindows.add(index)
        this.scenes[sceneName].windows[index].position.x = value
      }
    }
  }

  getWindowY (index, scene) {
    const sceneName = scene || this.currentScene
    if (this.scenes[sceneName].windows.length > index) return this.scenes[sceneName].windows[index].position.y
  }

  setWindowY (index, value, scene) {
    const sceneName = scene || this.currentScene
    if (this.scenes[sceneName].windows.length > index) {
      const old = this.scenes[sceneName].windows[index].position.y
      if (value !== old) {
        this.scenes[sceneName].changedWindows.add(index)
        this.scenes[sceneName].windows[index].position.y = value
      }
    }
  }

  getWindowWidth (index, scene) {
    const sceneName = scene || this.currentScene
    if (this.scenes[sceneName].windows.length > index) return this.scenes[sceneName].windows[index].width
  }

  setWindowWidth (index, value, scene) {
    const sceneName = scene || this.currentScene
    if (this.scenes[sceneName].windows.length > index) {
      const old = this.scenes[sceneName].windows[index].width
      if (value !== old) {
        this.scenes[sceneName].changedWindows.add(index)
        this.scenes[sceneName].windows[index].width = value
      }
    }
  }

  getWindowHeight (index, scene) {
    const sceneName = scene || this.currentScene
    if (this.scenes[sceneName].windows.length > index) return this.scenes[sceneName].windows[index].height
  }

  setWindowHeight (index, value, scene) {
    const sceneName = scene || this.currentScene
    if (this.scenes[sceneName].windows.length > index) {
      const old = this.scenes[sceneName].windows[index].height
      if (value !== old) {
        this.scenes[sceneName].changedWindows.add(index)
        this.scenes[sceneName].windows[index].height = value
      }
    }
  }

  addSourceAlias (sourceAlias, sceneItemId, sceneName) {
    if (this.scenes[sceneName]) {
      this.scenes[sceneName].sourceAliases[sourceAlias.toLowerCase().replace(/\W/g, '-')] = parseInt(sceneItemId)
    }
  }

  removeAliasesForSource (sceneItemId, sceneName) {
    if (this.scenes[sceneName]) {
      for (const alias in this.scenes[sceneName].sourceAliases) {
        if (this.scenes[sceneName].sourceAliases[alias] === sceneItemId) delete this.scenes[sceneName].sourceAliases[alias]
      }
    }
  }

  addSceneAlias (sceneAlias, sceneName) {
    if (sceneName && sceneName.length > 0 && sceneAlias && sceneAlias.length > 0) {
      this.sceneAliases[sceneAlias.toLowerCase().replace(/\W/g, '-')] = sceneName
    }
  }

  removeAliasesForScene (sceneName) {
    if (sceneName) {
      for (const key in this.sceneAliases) if (this.sceneAliases[key] === sceneName) delete this.sceneAliases[key]
    }
  }

  updateSourceWindow (sceneItemId, sceneName) {
    sceneName = sceneName || this.currentScene
    const cams = this.scenes[sceneName].cams
    const windows = this.scenes[sceneName].windows
    const source = this.scenes[sceneName].sources[sceneItemId]
    for (let i = 0; i < cams.length; i++) {
      if (cams[i] === sceneItemId) { // Found the source in current visible cams
        windows[i].position.x = source.position.x
        windows[i].position.y = source.position.y
        if (source.width > 0) windows[i].width = source.width // Bug #84: don't set windows to width 0
        if (source.height > 0) windows[i].height = source.height // Bug #84: don't set windows to height 0
        break
      }
    }
  }

  removeSource (sceneItemId, sceneName) {
    if (this.scenes[sceneName] && sceneItemId in this.scenes[sceneName].sources) {
      const sourceName = this.scenes[sceneName].sources[sceneItemId].sourceName
      // Remove from aliases
      this.removeAliasesForSource(sceneItemId, sceneName)

      // Remove from the scenes sources
      delete this.scenes[sceneName].sources[sceneItemId]

      this.logger.info(`Removed source '${sourceName}' from scene '${sceneName}'`)
    }
  }

  renameSource (oldName, newName) {
    // Source names are unique in OBS, so if you rename one, it will change the name in every scene
    if (oldName !== newName) {
      for (const sceneName in this.scenes) {
        const sceneItemId = this.getSourceIdByName(oldName, sceneName)

        if (sceneItemId) {
          this.scenes[sceneName].sources[sceneItemId].sourceName = newName

          // Remove old alias
          const oldAlias = oldName.toLowerCase().replace(/\W/g, '-')
          if (this.scenes[sceneName].sourceAliases[oldAlias]) delete this.scenes[sceneName].sourceAliases[oldAlias]

          // Add new alias
          this.addSourceAlias(newName, sceneItemId, sceneName)
        }
      }
      this.logger.info(`Renamed source '${oldName}' to '${newName}'`)
    }
  }

  getSceneAliases () {
    return Object.keys(this.sceneAliases)
  }

  setCurrentScene (sceneAlias) {
    const sceneName = this.sceneAliases[sceneAlias]
    if (sceneName) {
      return this.obs.call('SetCurrentProgramScene', { sceneName: sceneName })
        .catch(e => { this.logger.error(`OBS error switching scenes: ${JSON.stringify(e, null, 2)}`) })
    }
  }

  renameScene (oldName, newName) {
    if (oldName in this.scenes) {
      // replace aliases
      this.removeAliasesForScene(oldName)
      this.addSceneAlias(newName, newName)

      // replace scenes
      this.scenes[newName] = this.scenes[oldName]
      delete this.scenes[oldName]

      if (this.currentScene === oldName) this.currentScene = newName

      this.logger.info(`Renamed scene '${oldName}' to '${newName}'`)
    }
  }

  deleteScene (sceneName) {
    if (sceneName in this.scenes) delete this.scenes[sceneName]
    this.removeAliasesForScene(sceneName)
    this.logger.info(`Deleted scene '${sceneName}'`)
  }

  async addSourceItem (sceneItemId, sceneName) {
    return this.scenesRenderer.getSceneItemList(sceneName)
      .then(sources => {
        sources.sceneItems.forEach(source => {
          if (source.sceneItemId === sceneItemId) {
            this.scenes[sceneName].sources[sceneItemId] = source
            this.addSourceAlias(source.sourceName, sceneItemId, sceneName)
          }
        })
      })
  }

  updateSourceItem (sceneName, source) {
    // Update the source object
    if (sceneName in this.scenes) {
      if (this.scenes[sceneName].sources[source.sceneItemId] && !source.kind) source.kind = this.scenes[sceneName].sources[source.sceneItemId].kind // The kind may not be in the message, but we want to keep it
      this.scenes[sceneName].sources[source.sceneItemId] = source

      // Make sure there's an alias
      this.addSourceAlias(source.sourceName, source.sceneItemId, sceneName)

      // If it's currently in a window, update the window dimensions
      this.updateSourceWindow(source.sceneItemId, sceneName)

      this.logger.info(`Updated source '${source.name}' in scene '${sceneName}'`)
      this.logger.debug(`Updated source '${source.name}' in scene '${sceneName}': ${JSON.stringify(source, null, 2)}`)
    } else this.logger.warn(`Source not updated. Scene '${sceneName}' doesn't exist`)
  }

  // Handlers for OBS events //////////////////////////////////////////////////
  sceneItemEnableStateChanged (data) {
    const source = this.getSourceByName(data.itemName, data.sceneName)
    source.visible = data.itemVisible
    this.logger.info(`${data.itemVisible ? 'Show' : 'Hide'} source '${data.itemName}' in scene '${data.sceneName}'`)
    this.logger.debug(`Event OBS:SceneItemEnableStateChanged: ${JSON.stringify(data, null, 2)}`)
  }

  sceneItemTransformChanged (data) {
    this.logger.log(`TODO: implement SceneItemTransformChanged: scene ${data.sceneName}, item ${data.sceneItemId}`)
  }

  switchScenes (data) {
    if (this.currentScene !== data.sceneName) {
      const oldScene = this.currentScene
      this.currentScene = data.sceneName
      this.logger.info(`Switched scene from '${oldScene}' to '${this.currentScene}'`)
    }
  }

  inputNameChanged (data) {
    this.renameSource(data.oldInputName, data.inputName)
  }

  sceneItemRemoved (data) {
    this.removeSource(data.sceneItemId, data.sceneName)
  }

  sceneItemCreated (data) {
    this.addSourceItem(data.sceneItemId, data.sceneName)
      .catch(e => this.logger.error(`Unable to add new source '${data.sourceName}' for scene '${this.currentScene}': ${JSON.stringify(e)}`))
  }

  getSourceNameFromSceneItemId (sceneName, sceneId) {
    for (const [sourceName, source] of Object.entries(this.scenes[sceneName].sources)) {
      if (source.sceneItemId === sceneId) {
        return sourceName
      }
    }

    return ''
  }

  /// //////////////////////////////////////////////////////////////////////////

  /**
   * Given an obs connection, grab all the scenes and resources to construct the cams and windows
   */
  async syncFromObs () {
    // Grab all the scenes from OBS
    return this.obs.call('GetSceneList')
      .then(async data => {
        this.currentScene = data.currentProgramSceneName
        this.logger.info(`Current OBS scene: '${this.currentScene}'`)
        return this.scenesRenderer.getScenes(data.scenes, this.windowKinds)
          .then(scenes => {
            this.scenes = scenes
            this.sceneAliases = getSceneAliases(scenes)

            this.logger.info(`Synced scenes from OBS: '${Object.keys(this.scenes).join('\', \'')}'`)
          })
          .catch(e => { this.logger.error(`Error syncing scenes from OBS: ${e.message}`) })
      })
  }

  /**
  Update OBS with only the cameras that have changed
  */
  updateOBS (sceneName) {
    sceneName = sceneName || this.currentScene
    if (sceneName) {
      const windows = getWindowsFromScene(this.scenes[sceneName])

      if (this.scenes[sceneName].changedCams.size > 0) {
        this.logger.info(`Changed cams: ${Array.from(this.scenes[sceneName].changedCams).join(', ')}`)
      }
      if (this.scenes[sceneName].changedWindows.size > 0) {
        this.logger.info(`Changed windows: ${Array.from(this.scenes[sceneName].changedWindows).join(', ')}`)
      }
      this.logger.debug(`Updated windows: ${JSON.stringify(windows, null, '  ')}`)

      let i = 0
      Promise.all(windows.map(async window => {
        if (this.scenes[sceneName].changedCams.has(window.sceneItemId) || this.scenes[sceneName].changedWindows.has(i++)) {
          const itemEnabled = {
            sceneName: window.sceneName,
            sceneItemId: window.sceneItemId,
            sceneItemEnabled: true
          }
          return this.obs.call('SetSceneItemEnabled', itemEnabled)
            .catch(err => {
              this.logger.warn(`Unable to show '${window.sceneItemId}' for scene '${sceneName}': ${JSON.stringify(err)}`)
            })
            .then(() => {
              return this.obs.call('GetSceneItemTransform', { sceneName: sceneName, sceneItemId: window.sceneItemId })
            })
            .catch(err => {
              this.logger.warn(`Unable to get the source dimensions to move '${window.sceneItemId}' for scene '${sceneName}': ${JSON.stringify(err)}`)
            })
            .then(sourceData => {
              window.sceneItemTransform.scaleX = window.sceneItemTransform.width / sourceData.sceneItemTransform.sourceWidth
              window.sceneItemTransform.scaleY = window.sceneItemTransform.height / sourceData.sceneItemTransform.sourceHeight
            })
            .then(() => {
              return this.obs.call('SetSceneItemTransform', window)
            })
            .catch(err => {
              this.logger.warn(`Unable to update '${this.getNameBySourceId(window.sceneItemId, window.sceneName)}' for scene '${sceneName}': ${JSON.stringify(err)}`)
            })
            .then(() => {
              this.scenes[sceneName].changedCams.delete(window.sceneItemId)
              this.scenes[sceneName].changedWindows.delete(i - 1)
            })
        }
      }))
        .then(() => {
        // Anything left needs to be hidden
          this.scenes[sceneName].changedCams.forEach(cam => {
            if (!this.scenes[sceneName].cams.includes(cam)) {
              const itemDisabled = {
                sceneName: sceneName,
                sceneItemId: cam,
                sceneItemEnabled: false
              }
              this.obs.call('SetSceneItemEnabled', itemDisabled)
                .catch(err => {
                  this.logger.warn(`Unable to hide '${cam}' for scene '${sceneName}': ${err.error}`)
                })
                .then(() => {
                  this.scenes[sceneName].changedCams.delete(cam)
                })
            }
          })
        })
        .catch(e => {
          this.logger.error(`Updating OBS scene windows: ${JSON.stringify(e)}`)
        })

      this.storedWindows = windows
    }
  }

  // TODO: implement the ability to timeout a user for abusing the cams
  cameraTimeout (user) {
    return false
  }
}

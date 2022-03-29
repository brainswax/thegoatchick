import { Stojo } from '@codegrill/stojo'

function sortWindows (a, b) {
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
}

function getSceneAliases (scenes) {
  const sceneAliases = {} // Needs to be an Object, not Map, in order to persist it in the object store
  for (const sceneName in scenes) sceneAliases[sceneName.toLowerCase().replace(/\W/g, '-')] = sceneName
  return sceneAliases
}

function getSourceAliases (sources) {
  const sourceAliases = {} // Needs to be an Object, not Map, in order to persist it in the object store
  for (const sourceName in sources) sourceAliases[sourceName.toLowerCase().replace(/\W/g, '-')] = sourceName
  return sourceAliases
}

function getSceneCams (windows) {
  const cams = []
  windows.forEach(window => cams.push(window.source))
  return cams
}

function getSceneWindows (scene, windowKinds) {
  const windows = []
  for (const sourceName in scene.sources) {
    const source = scene.sources[sourceName]

    if (source.visible && windowKinds.includes(source.kind)) { // Only visible media sources are treated as windows
      windows.push({
        source: source.name,
        position: source.position,
        width: source.width,
        height: source.height
      })
    }
  }

  return windows
}

function getWindows (scene) {
  const windows = []

  if (scene && scene.windows) {
    let i = 0
    scene.windows.forEach(window => {
      if (scene.cams && scene.cams.length > i) {
        const sourceName = scene.cams[i++]
        windows.push({
          item: sourceName,
          position: window.position,
          scale: {
            filter: scene.sources[sourceName].scale.filter || 'OBS_SCALE_DISABLE',
            x: window.width / scene.sources[sourceName].sourceWidth,
            y: window.height / scene.sources[sourceName].sourceHeight
          },
          visible: true
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

  async getSceneItemProperties (sceneName, sourceName) {
    const sceneItem = { item: sourceName }
    sceneItem['scene-name'] = sceneName
    return this.obs.send('GetSceneItemProperties', sceneItem)
  }

  async getSceneSource (sceneName, sourceData) {
    return this.getSceneItemProperties(sceneName, sourceData.name)
      .catch(e => this.logger.error(`Error getting scene properties for scene: ${sceneName}, source: ${sourceData.name}: ${JSON.stringify(e)}`))
      .then(source => {
        source.kind = sourceData.type
        return source
      })
  }

  async getSceneSources (sceneData) {
    const sources = {}
    return Promise.all(sceneData.sources.map(async sourceData => {
      return this.getSceneSource(sceneData.name, sourceData)
        .then(source => {
          sources[source.name] = source
        })
    }))
      .then(() => sources)
  }

  async getScene (sceneData) {
    const scene = {
      name: sceneData.name,
      changedCams: new Set(),
      changedWindows: new Set()
    }

    return this.getSceneSources(sceneData)
      .then(sources => {
        scene.sources = sources
        scene.sourceAliases = getSourceAliases(sources)
      })
      .then(() => scene)
  }

  async getScenes (scenesData, windowKinds) {
    const scenes = {}
    return Promise.all(scenesData.map(async sceneData => {
      return this.getScene(sceneData)
        .then(scene => {
          scene.windows = getSceneWindows(scene, windowKinds)
          scene.windows.sort((a, b) => sortWindows(a, b)) // Sort the windows for cam0, cam1, etc.
          scene.cams = getSceneCams(scene.windows) // Depends on the order of the windows
          scene.windows.forEach(window => { if (window.source) delete window.source }) // Don't need this now that we have sorted the windows
          scenes[scene.name] = scene
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
    this.commands.set('source', (...args) => this.showInfo(...args))
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
      if (this.commands.has(command)) this.commands.get(command)(chat, channel, alias, value)
    }
  }

  showInfo (chat, channel, alias, value) {
    const source = this.getSourceByAlias(alias)
    if (source) {
      chat.say(channel, `source w:${source.sourceWidth}, h:${source.sourceHeight}`)
    } else {
      this.logger.info(`No source info for '${alias}'`)
    }
  }

  commandWindows (chat, channel, message) {
    this.logger.debug(`OBS Sources: ${JSON.stringify(this.scenes[this.currentScene].sources, null, 2)}`)
    this.logger.debug(`Filtered sources: ${JSON.stringify(this.getSources(this.windowKinds), null, 2)}`)
    this.logger.debug(`Windows: ${JSON.stringify(this.scenes[this.currentScene].windows, null, 2)}`)
    chat.say(channel, `There are ${this.scenes[this.currentScene].windows.length} windows.`)
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
        if (!kinds || kinds.includes(source.kind)) { // If kinds is null, assume any kind
          sources.push(source.name.toLowerCase())
        }
      })
    }

    return sources
  }

  /**
   * Get the source object by alias name
   * @param {string} source an alias for the source
   * @param {string} scene the name of the scene
   * @returns the source objevt returned from OBS
   */
  getSourceByAlias (sourceAlias, sceneName) {
    if (this.scenes[sceneName]) {
      const sourceName = this.scenes[sceneName].sourceAliases[sourceAlias]
      if (sourceName) {
        return this.scenes[sceneName].sources[sourceName]
      }
    }
  }

  getAliases (scene) {
    return Object.keys(this.scenes[scene || this.currentScene].sourceAliases)
  }

  getWindows (scene) {
    return this.scenes[scene || this.currentScene].windows
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
        if (camName in this.scenes[this.currentScene].sourceAliases) { // Only add a commmand if there are aliases for the camera name
          const camIndex = i === 0 ? 0 : parseInt(word.slice(0, i)) // Assume 0 unless it starts with a number
          if (camIndex < this.scenes[this.currentScene].cams.length) { // Only add it if there's a camera window available
            commands[n++] = { index: camIndex, name: this.scenes[this.currentScene].sourceAliases[camName] } // Add the command to the array
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

  setWindow (index, name) {
    if (this.currentScene && this.scenes[this.currentScene]) {
      let currentIndex = -1
      this.logger.info(`Setting cam${index} to '${name}' for scene '${this.currentScene}'`)

      try {
        // get index of where the specified source is currently
        for (let x = 0; x < this.scenes[this.currentScene].cams.length; x++) {
          if (this.scenes[this.currentScene].cams[x] === name) currentIndex = x
        }

        if (index !== currentIndex) { // It's either not in a window or we're moving it to a different one
          this.scenes[this.currentScene].changedCams.add(name)
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

          this.scenes[this.currentScene].cams[index] = name
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

  addSourceAlias (sourceAlias, sourceName, sceneName) {
    if (this.scenes[sceneName]) {
      this.scenes[sceneName].sourceAliases[sourceAlias.toLowerCase().replace(/\W/g, '-')] = sourceName
    }
  }

  removeAliasesForSource (sourceName, sceneName) {
    if (this.scenes[sceneName]) {
      for (const key in this.scenes[sceneName].sourceAliases) {
        if (this.scenes[sceneName].sourceAliases[key] === sourceName) delete this.scenes[sceneName].sourceAliases[key]
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

  renameCams (oldName, newName, sceneName) {
    if (sceneName && sceneName in this.scenes) {
      for (let i = 0; i < this.scenes[sceneName].cams.length; i++) {
        if (this.scenes[sceneName].cams[i] === oldName) this.scenes[sceneName].cams[i] = newName
      }
    }
  }

  updateSourceWindow (sourceName, sceneName) {
    const cams = this.scenes[sceneName || this.currentScene].cams
    const windows = this.scenes[sceneName || this.currentScene].windows
    const source = this.scenes[sceneName || this.currentScene].sources[sourceName]
    for (let i = 0; i < cams.length; i++) {
      if (cams[i] === sourceName) { // Found the source in current visible cams
        windows[i].position.x = source.position.x
        windows[i].position.y = source.position.y
        windows[i].width = source.width
        windows[i].height = source.height
        break
      }
    }
  }

  /**
   * Find a source from any of the scenes and return the kind if there is one.
   *
   * OBS doesn't provide the sourceKind on a changed item and sources have unique names across scenes, so look for one rather than query OBS for it.
   * @param {string} sourceName
   * @returns
   */
  getKindFromSource (sourceName) {
    for (const k of Object.keys(this.scenes)) {
      if (this.scenes[k].sources[sourceName] && this.scenes[k].sources[sourceName].kind) {
        return this.scenes[k].sources[sourceName].kind
      }
    }
  }

  removeSource (sourceName, sceneName) {
    if (this.scenes[sceneName] && sourceName in this.scenes[sceneName].sources) {
      // Remove from aliases
      this.removeAliasesForSource(sourceName, sceneName)

      // Remove from the scenes sources
      delete this.scenes[sceneName].sources[sourceName]

      this.logger.info(`Removed source '${sourceName}' from scene '${sceneName}'`)
    }
  }

  renameSource (oldName, newName) {
    // Source names are unique in OBS, so if you rename one, it will change the name in every scene
    if (oldName !== newName) {
      for (const sceneName in this.scenes) {
        if (oldName in this.scenes[sceneName].sources) {
          this.scenes[sceneName].sources[newName] = this.scenes[sceneName].sources[oldName]
          this.scenes[sceneName].sources[newName].name = newName
          delete this.scenes[sceneName].sources[oldName]
        }

        // Remove old aliases
        this.removeAliasesForSource(oldName, sceneName)

        // Add new aliases
        this.addSourceAlias(newName, newName, sceneName)

        // Update cams
        this.renameCams(oldName, newName, sceneName)
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
      const s = {}
      s['scene-name'] = sceneName
      return this.obs.send('SetCurrentScene', s)
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

  async addSourceItem (sourceName, kind, sceneName) {
    const sceneItem = { item: sourceName }
    sceneItem['scene-name'] = sceneName

    return this.obs.send('GetSceneItemProperties', sceneItem) // Get the source info from obs
      .then(source => { // Add the source to the scene
        this.scenes[sceneName].sources[source.name] = source
        this.scenes[sceneName].sources[source.name].kind = kind
      })
      .then(() => { // Add an alias for the new source
        this.addSceneAlias(sourceName, sourceName)
      })
      .then(() => this.logger.info(`Added source '${sourceName}' for scene '${sceneName}'`))
  }

  updateSourceItem (sceneName, source) {
    // Update the source object
    if (sceneName in this.scenes) {
      if (this.scenes[sceneName].sources[source.name] && !source.kind) source.kind = this.scenes[sceneName].sources[source.name].kind // The kind may not be in the message, but we want to keep it
      this.scenes[sceneName].sources[source.name] = source

      // Make sure there's an alias
      this.addSourceAlias(source.name, source.name, sceneName)

      // If it's currently in a window, update the window dimensions
      this.updateSourceWindow(source.name, sceneName)

      this.logger.info(`Updated source '${source.name}' in scene '${sceneName}'`)
      this.logger.debug(`Updated source '${source.name}' in scene '${sceneName}': ${JSON.stringify(source, null, 2)}`)
    } else this.logger.info(`Source not updated. Scene '${sceneName}' doesn't exist`)
  }

  // Handlers for OBS events //////////////////////////////////////////////////
  sourceOrderChanged (data) {
    this.logger.info(`Source order changed for scene '${data.sceneName}'`)
    this.logger.debug(`Event OBS:SourceOrderChanged: ${JSON.stringify(data, null, 2)}`)
  }

  sceneItemVisibilityChanged (data) {
    // TODO: show/hide sources
    this.logger.info(`${data.itemVisible ? 'Show' : 'Hide'} source '${data.itemName}' in scene '${data.sceneName}'`)
    this.logger.debug(`Event OBS:SceneItemVisibilityChanged: ${JSON.stringify(data, null, 2)}`)
  }

  sceneItemTransformChanged (data) {
    // Update an existing source item
    const source = data.transform
    source.name = data['item-name']

    if (this.scenes[data['scene-name']] &&
        (!this.scenes[data['scene-name']].sources[data['item-name']] ||
        !this.scenes[data['scene-name']].sources[data['item-name']].kind)) { // This source already exists in at least one other scene
      source.kind = this.getKindFromSource(data['item-name']) // Grab the kind from it so we don't have to query OBS
    }

    this.updateSourceItem(data['scene-name'], source)
  }

  switchScenes (data) {
    if (this.currentScene !== data.sceneName) {
      this.logger.info(`Switched scene from '${this.currentScene}' to '${data.sceneName}'`)
      this.currentScene = data.sceneName
    }
  }

  sourceRenamed (data) {
    switch (data.sourceType) {
      case 'scene':
        this.renameScene(data.previousName, data.newName)
        break
      case 'input':
        this.renameSource(data.previousName, data.newName)
        break
      case 'group':
        this.logger.info(`Renamed group '${data.sourceName}'`)
        break
      default: // Shouldn't get here. Warn.
        this.logger.warn(`Renamed source '${data.sourceName}' of unknown type '${data.sourceType}'`)
    }
  }

  sourceDestroyed (data) {
    // Destroyed should be removed from all scenes
    switch (data.sourceType) {
      case 'scene':
        this.deleteScene(data.sourceName)
        break
      case 'input':
        this.logger.info(`Removed source '${data.sourceName}' from all scenes`)
        break
      case 'group':
        this.logger.info(`Removed group '${data.sourceName}' from all scenes`)
        break
      default: // Shouldn't get here. Warn.
        this.logger.warn(`Removed source '${data.sourceName}' of unknown type '${data.sourceType}' from all scenes`)
    }
  }

  sourceItemRemoved (data) {
    this.removeSource(data['item-name'], data['scene-name'])
  }

  sourceCreated (data) {
    if (data.sourceType === 'scene') { // Only log; OBS will trigger a ScenesChanged event with the data
      this.logger.info(`Created scene '${data.sourceName}'`)
    } else if (data.sourceType === 'input') {
      this.addSourceItem(data.sourceName, data.sourceKind, this.currentScene)
        .catch(e => this.logger.error(`Unable to add new source '${data.sourceName}' for scene '${this.currentScene}': ${JSON.stringify(e)}`))
    } else this.logger.info(`Created source '${JSON.stringify(data, null, 2)}'`)
  }

  async scenesChanged (data) {
    this.logger.info('Updating scenes')
    this.logger.debug(`Updating scenes: ${JSON.stringify(data, null, 2)}`)
    return this.scenesRenderer.getScenes(data.scenes, this.windowKinds)
      .then(scenes => {
        this.scenes = scenes
        this.sceneAliases = getSceneAliases(scenes)

        this.logger.info(`OBS scenes changed: '${Object.keys(this.scenes).join('\', \'')}'`)
      })
      .catch(e => { this.logger.error(`Error updated scene change: ${JSON.stringify(e)}`) })
  }
  /// //////////////////////////////////////////////////////////////////////////

  /**
   * Given an obs connection, grab all the scenes and resources to construct the cams and windows
   */
  async syncFromObs () {
    // Grab all the scenes from OBS
    return this.obs.send('GetSceneList')
      .then(async data => {
        this.currentScene = data['current-scene']
        this.logger.info(`Current OBS scene: '${this.currentScene}'`)
        return this.scenesRenderer.getScenes(data.scenes, this.windowKinds)
          .then(scenes => {
            this.scenes = scenes
            this.sceneAliases = getSceneAliases(scenes)

            this.logger.info(`Synced scenes from OBS: '${Object.keys(this.scenes).join('\', \'')}'`)
            this.logger.debug(`OBS Scenes: ${JSON.stringify(this.scenes, null, 2)}`)
          })
          .catch(e => { this.logger.error(`Error syncing from OBS: ${JSON.stringify(e)}`) })
      })
  }

  /**
  Update OBS with only the cameras that have changed
  */
  updateOBS (sceneName) {
    if (sceneName) {
      const windows = getWindows(this.scenes[sceneName])

      if (this.scenes[sceneName].changedCams.size > 0) {
        this.logger.info(`Changed cams: ${Array.from(this.scenes[sceneName].changedCams).join(', ')}`)
      }
      if (this.scenes[sceneName].changedWindows.size > 0) {
        this.logger.info(`Changed windows: ${Array.from(this.scenes[sceneName].changedWindows).join(', ')}`)
      }
      this.logger.debug(`Updated windows: ${JSON.stringify(windows, null, '  ')}`)

      let i = 0
      Promise.all(windows.map(async window => {
        if (this.scenes[sceneName].changedCams.has(window.item) || this.scenes[sceneName].changedWindows.has(i++)) {
          return this.obs.send('SetSceneItemProperties', window)
            .catch(err => { this.logger.warn(`Unable to set OBS properties '${window.item}' for scene '${sceneName}': ${JSON.stringify(err)}`) })
            .then(() => {
              this.scenes[sceneName].changedCams.delete(window.item)
              this.scenes[sceneName].changedWindows.delete(i - 1)
            })
        }
      }))
        .then(() => {
        // Anything left needs to be hidden
          this.scenes[sceneName].changedCams.forEach(cam => {
            if (!this.scenes[sceneName].cams.includes(cam)) {
              const view = { source: cam, render: false }
              view['scene-name'] = sceneName
              this.obs.send('SetSceneItemRender', view)
                .catch(err => { this.logger.warn(`Unable to hide OBS view '${cam}' for scene '${sceneName}': ${err.error}`) })
                .then(() => {
                  this.scenes[sceneName].changedCams.delete(cam)
                })
            }
          })
        })
        .catch(e => { this.logger.error(`Error updating obs scene windows: ${JSON.stringify(e)}`) })

      this.storedWindows = windows
    }
  }

  // TODO: implement the ability to timeout a user for abusing the cams
  cameraTimeout (user) {
    return false
  }
}

export default class OBSView {
  constructor (obs) {
    this.obs = obs

    this.obsWindows = [
      {
        item: 'one',
        position: { alignment: 5, x: 0, y: 169 },
        scale: { x: 0.942187488079071, y: 0.9417344331741333 },
        visible: true
      }, {
        item: 'two',
        position: { alignment: 5, x: 1241, y: 46 },
        scale: { x: 0.528124988079071, y: 0.5284552574157715 },
        visible: true
      }, {
        item: 'three',
        position: { alignment: 5, x: 1241, y: 472 },
        scale: { x: 0.528124988079071, y: 0.5243902206420898 },
        visible: true
      }]

    this.current = -1
    this.alias = []
  }

  processChat (msg) {
    const windowRegex = /[1-2]+/gm
    const wordsRegex = /\b(\w+)\b/gm
    const lettersRegex = /[a-z]+/gm

    // figure out what our window index is
    let windowIndex = 0
    const windowIndexMatch = msg.match(windowRegex)
    if (windowIndexMatch != null) {
      windowIndex = Number(windowIndexMatch[windowIndexMatch.length - 1])
    }

    // check for matching alias
    const matches = msg.toLowerCase().match(wordsRegex)
    if (matches == null) return
    let hasChanges = false
    let obsName

    matches.forEach(match => {
      const keyword = match.match(lettersRegex)
      if (keyword != null) {
        this.alias.forEach(alias => {
          if (alias.alias === keyword[0]) {
            obsName = alias.obsName
            hasChanges = true
          }
        })
      }
    })

    if (hasChanges) {
      this.setWindow(windowIndex, obsName)
      this.updateOBS()
    }
  }

  addView (obsName, aliases = []) {
    this.current++
    if (this.current > this.obsWindows.length - 1) {
      this.obsWindows[this.current] = {
        item: 'default',
        visible: false
      }
    }
    this.obsWindows[this.current].item = obsName

    aliases.forEach(alias => {
      this.addAlias(alias, obsName)
    })
  }

  addAlias (alias, obsName) {
    alias = alias.toLowerCase()
    this.alias.push({
      alias,
      obsName
    })
  }

  setWindow (index, name) {
    let currentIndex
    // get idex of where the view is currently
    for (let x = 0; x < this.obsWindows.length; x++) {
      if (this.obsWindows[x].item === name) currentIndex = x
    }
    const oldName = this.obsWindows[index].item

    // make swap
    this.obsWindows[index].item = name
    this.obsWindows[currentIndex].item = oldName
  }

  updateOBS () {
    this.obsWindows.forEach(camera => {
      this.obs.send('SetSceneItemProperties', camera)
    })
  }

  cameraTimeout (user) {
    switch (user.toLowerCase()) {
      // block users from using cams
      case 'matched-username':
        return true
    }
    return false
  }
}

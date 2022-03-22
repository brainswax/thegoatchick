const utils = {}

function getMapKeys (map) {
  const keys = []
  map.forEach((v, k) => keys.push(k))
  return keys
};

utils.getKeys = (m) => {
  if (m instanceof Map) {
    return getMapKeys(m)
  }

  return []
}

export { utils }

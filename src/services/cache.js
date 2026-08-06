const store = new Map();

function getOrSet(key, ttlMs, factory) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.time < ttlMs) return hit.promise;

  const promise = Promise.resolve()
    .then(factory)
    .catch((err) => {
      store.delete(key);
      throw err;
    });

  store.set(key, { time: now, promise });
  return promise;
}

module.exports = { getOrSet };

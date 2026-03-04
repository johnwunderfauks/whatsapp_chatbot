// helpers/services/stateService.js
function createStateService(config, logger) {
  const store = new Map();

  function now() {
    return Date.now();
  }

  function getEntry(key) {
    const existing = store.get(key);
    if (!existing) {
      const entry = { data: {}, expiresAt: now() + config.state.ttlMs };
      store.set(key, entry);
      return entry;
    }
    if (existing.expiresAt && now() > existing.expiresAt) {
      const entry = { data: {}, expiresAt: now() + config.state.ttlMs };
      store.set(key, entry);
      return entry;
    }
    return existing;
  }

  async function getChatState(key) {
    return getEntry(key).data;
  }

  async function updateChatState(key, patch = {}) {
    const entry = getEntry(key);
    entry.data = { ...(entry.data || {}), ...(patch || {}) };
    entry.expiresAt = now() + config.state.ttlMs;
    store.set(key, entry);
    return entry.data;
  }

  return { getChatState, updateChatState, _store: store };
}

module.exports = { createStateService };
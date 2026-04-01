// helpers/logger.js

function createLogger() {
  function logToFile(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
  }

  return { logToFile };
}

module.exports = { createLogger };

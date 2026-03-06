// helpers/logger.js
const fs = require("fs");
const path = require("path");

function createLogger(config) {
  const logPath = path.resolve(process.cwd(), config.log.file);

  function logToFile(message) {
    const line = `[${new Date().toISOString()}] ${message}`;

    // Show in Railway logs
    console.log(line);

    // Also persist to file if possible
    fs.appendFile(logPath, `${line}\n`, "utf8", (err) => {
      if (err) {
        console.warn("[warn] log write failed:", err.message);
      }
    });
  }

  return { logToFile };
}

module.exports = { createLogger };
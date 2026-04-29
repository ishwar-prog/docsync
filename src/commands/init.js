const logger = require('../utils/logger');
const { loadConfig, writeDefaultConfig } = require('../utils/config');

async function initCommand(options) {
  logger.header('DocSync — Initializing');
  logger.newline();

  // Step 1: Write config file if it doesn't exist
  writeDefaultConfig();

  // Step 2: Load the config
  const config = loadConfig();

  logger.success('DocSync initialized successfully.');
  logger.info('Next: Edit docsync.yaml to configure which files to track.');
  logger.info('Then run: docsync check');
}

module.exports = initCommand;
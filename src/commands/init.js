const path = require('path');
const logger = require('../utils/logger');
const { loadConfig, writeDefaultConfig } = require('../utils/config');
const { scanRepository } = require('../core/scanner');
const { parseFiles } = require('../core/parser');

async function initCommand(options) {
  logger.header('DocSync — Initializing');
  logger.newline();

  const cwd = process.cwd();

  // Step 1: Write config file if it doesn't exist
  writeDefaultConfig(cwd);

  // Step 2: Load the config
  const config = loadConfig(cwd);

  // Step 3: Scan the repository for trackable files
  const scanResult = await scanRepository(cwd, config);

  if (scanResult.totalFound === 0) {
    logger.warn('No files to parse. Check your docsync.yaml track patterns.');
    return;
  }

  // Step 4: Parse all found files
  logger.header('Parsing Files');
  const parsedFiles = await parseFiles(scanResult.files);

  // Step 5: Show what was found
  logger.newline();
  logger.header('Extraction Summary');

  let totalConstructs = 0;
  for (const file of parsedFiles) {
    const relativePath = path.relative(cwd, file.filePath).replace(/\\/g, '/');
    logger.info(`${relativePath} — ${file.constructCount} construct(s)`);

    for (const construct of file.constructs) {
      const icon = construct.kind === 'api_route' ? '🛣' :
                   construct.kind === 'class' ? '🏗' : '⚡';
      logger.info(`   ${icon} ${construct.kind}: ${construct.name} (line ${construct.location.startLine})`);
    }
    totalConstructs += file.constructCount;
  }

  logger.newline();
  logger.success(`Total: ${parsedFiles.length} file(s), ${totalConstructs} construct(s) extracted`);
  logger.info('Next: Run `docsync check` to detect documentation drift');
}

module.exports = initCommand;
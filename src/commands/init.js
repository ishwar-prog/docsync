'use strict';

const logger = require('../utils/logger');
const { loadConfig, writeDefaultConfig } = require('../utils/config');
const { scanRepository } = require('../core/scanner');
const { parseFiles } = require('../core/parser');
const { writeSnapshot, snapshotExists } = require('../core/snapshot');

async function initCommand() {
  logger.header('DocSync — Initializing');
  logger.newline();
``
  const cwd = process.cwd();

  // Step 1: Write config if missing
  writeDefaultConfig(cwd);

  // Step 2: Load config
  const config = loadConfig(cwd);

  // Step 3: Warn if re-initializing
  if (snapshotExists(cwd)) {
    logger.warn('Existing snapshot found. Re-initializing will reset your baseline.');
    logger.info('All drift history will be cleared. A fresh snapshot will be created.');
    logger.newline();
  }

  // Step 4: Scan
  const scanResult = await scanRepository(cwd, config);
  if (scanResult.totalFound === 0) {
    logger.warn('No files to parse. Check your docsync.yaml track patterns.');
    return;
  }

  // Step 5: Parse
  logger.header('Parsing Files');
  const parsedFiles = await parseFiles(scanResult.files);

  // Step 6: Write snapshot — this is the baseline
  logger.newline();
  logger.header('Creating Baseline Snapshot');
  writeSnapshot(cwd, parsedFiles, { repoRoot: cwd });

  // Step 7: Summary
  logger.newline();
  logger.header('Extraction Summary');
  let totalConstructs = 0;
  for (const file of parsedFiles) {
    const rel = file.filePath
      .replace(/\\/g, '/')
      .split('/')
      .slice(-3)
      .join('/');
    logger.info(`${rel} — ${file.constructCount} construct(s)`);
    for (const c of file.constructs) {
      const icon = c.kind === 'api_route' ? '🛣' : c.kind === 'class' ? '🏗' : '⚡';
      logger.info(`   ${icon} ${c.kind}: ${c.name} (line ${c.location.startLine})`);
    }
    totalConstructs += file.constructCount;
  }

  logger.newline();
  logger.success(`Baseline created: ${parsedFiles.length} file(s), ${totalConstructs} construct(s) snapshotted`);
  logger.info('Now run: docsync check — to detect drift at any time');
}

module.exports = initCommand;
'use strict';

const logger = require('../utils/logger');
const { loadConfig, writeDefaultConfig } = require('../utils/config');
const { scanRepository } = require('../core/scanner');
const { parseFiles } = require('../core/parser');
const { writeSnapshot, snapshotExists } = require('../core/snapshot');

async function initCommand(options) {
  logger.header('DocSync — Initializing');
  logger.newline();

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

  // Step 5: Handle zero-files case — write an empty snapshot so
  // .docsync/snapshot.json is ALWAYS created after `init`, regardless of
  // whether any files matched. This lets the user know init ran successfully
  // and gives them actionable guidance to fix their track patterns.
  if (scanResult.totalFound === 0) {
    logger.warn('No files matched your track patterns in docsync.yaml.');
    logger.newline();
    logger.info('Current track patterns:');
    for (const pattern of config.track) {
      logger.info(`  - ${pattern}`);
    }
    logger.newline();
    logger.info('This usually means one of the following:');
    logger.info('  1. Your source files are not inside a src/ directory.');
    logger.info('  2. Your files use extensions not listed in the track patterns.');
    logger.info('  3. The project has no .js / .ts files yet.');
    logger.newline();
    logger.info('To fix: edit docsync.yaml and update the `track` section. Example:');
    logger.info('  track:');
    logger.info('    - "**/*.js"');
    logger.info('    - "**/*.ts"');
    logger.newline();
    logger.info('Writing an empty baseline snapshot now.');
    logger.info('Re-run `npx @ishwarrr/docsync init` after updating your track patterns.');
    logger.newline();

    // Always write .docsync/snapshot.json — even if empty — so the file exists
    writeSnapshot(cwd, [], { repoRoot: cwd });
    return;
  }

  // Step 6: Parse
  logger.header('Parsing Files');
  const parsedFiles = await parseFiles(scanResult.files);

  // Step 7: Write snapshot — this is the baseline
  logger.newline();
  logger.header('Creating Baseline Snapshot');
  writeSnapshot(cwd, parsedFiles, { repoRoot: cwd });

  // Step 8: Summary
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
      const icon = c.kind === 'api_route' ? '\uD83D\uDEE3' : c.kind === 'class' ? '\uD83C\uDFD7' : '\u26A1';
      logger.info(`   ${icon} ${c.kind}: ${c.name} (line ${c.location.startLine})`);
    }
    totalConstructs += file.constructCount;
  }

  logger.newline();
  logger.success(`Baseline created: ${parsedFiles.length} file(s), ${totalConstructs} construct(s) snapshotted`);
  logger.info('Now run: npx @ishwarrr/docsync check — to detect drift at any time');
}

module.exports = initCommand;
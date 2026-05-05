'use strict';

const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const { loadConfig } = require('../utils/config');
const { scanRepository } = require('../core/scanner');
const { parseFiles } = require('../core/parser');
const { readSnapshot, writeSnapshot, snapshotExists } = require('../core/snapshot');
const { analyzeDrift } = require('../core/drift');
const {
  generateDocumentationForDrift,
  renderDocumentationAsMarkdown,
} = require('../core/generator');

async function fixCommand() {
  logger.header('DocSync — Generating Documentation');
  logger.newline();

  const cwd = process.cwd();
  const config = loadConfig(cwd);

  if (!snapshotExists(cwd)) {
    logger.error('No snapshot found. Run `docsync init` first.');
    process.exit(2);
  }

  const snapshot = readSnapshot(cwd);
  if (!snapshot) {
    logger.error('Snapshot corrupted. Run `docsync init` to rebuild.');
    process.exit(2);
  }

  // Scan and parse
  const scanResult = await scanRepository(cwd, config);
  if (scanResult.totalFound === 0) {
    logger.warn('No trackable files found.');
    return;
  }

  logger.header('Parsing Files');
  const parsedFiles = await parseFiles(scanResult.files);
  logger.newline();

  // Detect drift
  const driftReport = analyzeDrift(snapshot, parsedFiles, cwd);

  if (!driftReport.hasDrift) {
    logger.success('No drift detected — docs are already in sync.');
    return;
  }

  logger.info(`Drift score: ${driftReport.driftScore}/100`);
  logger.info(`${driftReport.summary.totalChanges} change(s) across ${driftReport.summary.filesAffected} file(s)`);
  logger.newline();

  // Generate documentation with Claude
  const generationSummary = await generateDocumentationForDrift(parsedFiles, driftReport);

  // Write generated docs to the output directory
  const outputDir = path.join(cwd, config.output?.dir || 'docs');
  await fs.ensureDir(outputDir);

  for (const result of generationSummary.results) {
    const fileName = result.filePath
      .replace(/\\/g, '/').split('/').pop()
      .replace(/\.(js|ts|jsx|tsx)$/, '.md');

    const outputPath = path.join(outputDir, fileName);
    const markdown = renderDocumentationAsMarkdown(result, result.filePath);

    await fs.outputFile(outputPath, markdown, 'utf8');
    logger.success(`Written: ${path.relative(cwd, outputPath)}`);
  }

  // Update the snapshot now that docs are generated
  logger.newline();
  logger.header('Updating Snapshot');
  writeSnapshot(cwd, parsedFiles, { repoRoot: cwd });

  logger.newline();
  logger.success('Documentation generated and snapshot updated.');
  logger.info(`Files written to: ${config.output?.dir || 'docs/'}`);
  logger.info('Review the generated docs then commit them to your repo.');
}

module.exports = fixCommand;
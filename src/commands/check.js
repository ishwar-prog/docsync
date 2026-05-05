'use strict';

const path = require('path');
const chalk = require('chalk');
const logger = require('../utils/logger');
const { loadConfig } = require('../utils/config');
const { scanRepository } = require('../core/scanner');
const { parseFiles } = require('../core/parser');
const { readSnapshot, snapshotExists } = require('../core/snapshot');
const { analyzeDrift } = require('../core/drift');

/**
 * `docsync check` — The developer's daily driver command.
 *
 * This command answers one question: "Are my docs still accurate?"
 *
 * Exit codes (important for CI integration):
 *   0 = No drift detected. Docs are in sync.
 *   1 = Drift detected above threshold. Docs need updating.
 *   2 = Error (missing snapshot, config error, etc.)
 *
 * Why explicit exit codes?
 * Because GitHub Actions, Jenkins, CircleCI, and every CI system
 * reads exit codes to determine pass/fail. Exit code 1 = red build.
 * This is how `eslint`, `tsc`, and `jest` signal failures to CI.
 */
async function checkCommand(options) {
  logger.header('DocSync — Drift Check');
  logger.newline();

  const cwd = process.cwd();
  const config = loadConfig(cwd);

  // Guard: snapshot must exist before we can check drift.
  // Without a baseline, there's nothing to compare against.
  if (!snapshotExists(cwd)) {
    logger.error('No snapshot found. Run `npx @ishwarrr/docsync init` first to create a baseline.');
    logger.info('DocSync needs a baseline snapshot to detect drift.');
    logger.info('Run: npx @ishwarrr/docsync init');
    process.exit(2);
  }

  // Step 1: Read the saved snapshot
  const snapshot = readSnapshot(cwd);
  if (!snapshot) {
    logger.error('Snapshot is corrupted or incompatible. Run `npx @ishwarrr/docsync init` to rebuild.');
    process.exit(2);
  }

  logger.success(`Snapshot loaded (taken ${snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : 'unknown'})`);
  logger.info(`Baseline: ${snapshot.totalFiles} file(s), ${snapshot.totalConstructs} construct(s)`);
  logger.newline();

  // Step 2: Scan and parse current state of the repo
  logger.info('Scanning current codebase...');
  const scanResult = await scanRepository(cwd, config);

  if (scanResult.totalFound === 0) {
    logger.warn('No trackable files found. Check your docsync.yaml track patterns.');
    process.exit(2);
  }

  const currentFiles = await parseFiles(scanResult.files);
  logger.newline();

  // Step 3: Run drift analysis
  const driftReport = analyzeDrift(snapshot, currentFiles, cwd);

  // Step 4: Display the report
  if (options.json) {
    // Machine-readable output for CI pipelines and integrations
    console.log(JSON.stringify(driftReport, null, 2));
  } else {
    displayDriftReport(driftReport, config, cwd);
  }

  // Step 5: Exit with appropriate code
  const threshold = config.drift?.threshold ?? 75;
  if (driftReport.driftScore >= threshold) {
    process.exit(1); // Signal failure to CI
  } else {
    process.exit(0); // Signal success
  }
}

/**
 * Displays a human-readable drift report in the terminal.
 *
 * @param {DriftReport} report
 * @param {object} config
 * @param {string} cwd
 */
function displayDriftReport(report, config, cwd) {
  const threshold = config.drift?.threshold ?? 75;

  // ── Repo-Level Score Banner ──────────────────────────────────────────────
  logger.header('Drift Report');
  logger.newline();

  const scoreColor = getScoreColor(report.driftScore);
  const scoreBar = buildScoreBar(report.driftScore);

  console.log(
    `  Drift Score: ${scoreColor(`${report.driftScore}/100`)}  ${scoreBar}`
  );
  console.log(
    `  Threshold:   ${chalk.gray(`${threshold}/100`)}`
  );
  console.log(
    `  Status:      ${report.driftScore >= threshold
      ? chalk.red.bold('⚠ DRIFT DETECTED — docs need updating')
      : chalk.green.bold('✓ DOCS IN SYNC')
    }`
  );

  if (report.snapshotAge) {
    console.log(`  Snapshot:    ${chalk.gray(report.snapshotAge)}`);
  }

  logger.newline();

  // ── No Drift Case ─────────────────────────────────────────────────────────
  if (!report.hasDrift) {
    logger.success('No documentation drift detected.');
    logger.info('Your docs accurately describe your current codebase.');
    return;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  logger.header(`Changes Detected (${report.summary.totalChanges} total across ${report.summary.filesAffected} file(s))`);
  logger.newline();

  // Display change type summary
  for (const [type, count] of Object.entries(report.summary.byType)) {
    const label = CHANGE_TYPE_LABELS[type] || type;
    const icon = CHANGE_TYPE_ICONS[type] || '•';
    console.log(`  ${icon} ${label}: ${chalk.yellow(count)}`);
  }

  logger.newline();

  // ── Per-File Detail ──────────────────────────────────────────────────────
  logger.header('Affected Files');
  logger.newline();

  for (const fileReport of report.files) {
    // Show relative path for readability
    const displayPath = fileReport.fileKey
      .replace(/\\/g, '/')
      .split('/')
      .slice(-3)  // Show last 3 path segments to keep it readable
      .join('/');

    const scoreColor = getScoreColor(fileReport.driftScore);

    console.log(
      `  ${chalk.bold(displayPath)} ${scoreColor(`[${fileReport.driftScore}/100]`)}`
    );

    for (const change of fileReport.changes) {
      const icon = CHANGE_TYPE_ICONS[change.type] || '•';
      const severityColor = change.severity >= 70
        ? chalk.red
        : change.severity >= 40
          ? chalk.yellow
          : chalk.gray;

      console.log(
        `    ${icon} ${severityColor(change.detail)}`
      );
    }
    logger.newline();
  }

  // ── Action Prompt ─────────────────────────────────────────────────────────
  if (report.driftScore >= threshold) {
    logger.header('Next Steps');
    console.log(`  Run ${chalk.cyan('npx @ishwarrr/docsync fix')} to auto-generate updated documentation`);
    console.log(`  Or update your docs manually and run ${chalk.cyan('npx @ishwarrr/docsync init')} to reset the baseline`);
    logger.newline();
  }
}

/**
 * Returns a chalk color function based on drift score severity.
 * Green < 40, Yellow 40–74, Red 75+
 */
function getScoreColor(score) {
  if (score < 40) return chalk.green;
  if (score < 75) return chalk.yellow;
  return chalk.red;
}

/**
 * Builds a visual ASCII progress bar for the drift score.
 * e.g., score 60 → "██████░░░░ 60%"
 */
function buildScoreBar(score) {
  const filled = Math.round(score / 10);
  const empty = 10 - filled;
  const color = getScoreColor(score);
  return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

// Human-readable labels for change types
const CHANGE_TYPE_LABELS = {
  CONSTRUCT_ADDED:        'New undocumented constructs',
  CONSTRUCT_DELETED:      'Deleted constructs (docs still reference them)',
  PARAM_ADDED:            'Parameters added',
  PARAM_REMOVED:          'Parameters removed',
  PARAM_RENAMED:          'Parameters renamed',
  PARAM_TYPE_CHANGED:     'Parameter types changed',
  RETURN_TYPE_CHANGED:    'Return types changed',
  ASYNC_CHANGED:          'Async status changed',
  JSDOC_REMOVED:          'JSDoc documentation removed',
  PARAM_DEFAULT_CHANGED:  'Parameter defaults changed',
};

const CHANGE_TYPE_ICONS = {
  CONSTRUCT_ADDED:        chalk.green('+'),
  CONSTRUCT_DELETED:      chalk.red('−'),
  PARAM_ADDED:            chalk.green('+'),
  PARAM_REMOVED:          chalk.red('−'),
  PARAM_RENAMED:          chalk.yellow('~'),
  PARAM_TYPE_CHANGED:     chalk.yellow('~'),
  RETURN_TYPE_CHANGED:    chalk.yellow('~'),
  ASYNC_CHANGED:          chalk.yellow('~'),
  JSDOC_REMOVED:          chalk.red('−'),
  PARAM_DEFAULT_CHANGED:  chalk.gray('·'),
};

module.exports = checkCommand;
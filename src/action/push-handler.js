'use strict';

const path = require('path');
const core = require('@actions/core');

const { scanRepository } = require('../core/scanner');
const { parseFiles } = require('../core/parser');
const { readSnapshot, writeSnapshot, snapshotExists } = require('../core/snapshot');
const { analyzeDrift } = require('../core/drift');
const { loadConfig } = require('../utils/config');
const { reporter } = require('./reporter');

/**
 * PUSH HANDLER FOR GITHUB ACTIONS
 *
 * Handles push events to monitored branches (typically main/master).
 *
 * The push handler's job is different from the PR handler:
 * - PR handler: detect drift in CHANGED files, generate docs, open companion PR
 * - Push handler: update the snapshot when docs have been verified correct
 *
 * WHY UPDATE THE SNAPSHOT ON PUSH?
 *
 * When a developer merges a companion PR (with updated docs) AND their
 * code PR, both changes land on main. The snapshot should be updated
 * to reflect this new "docs are accurate" state.
 *
 * If we don't update the snapshot, DocSync will keep flagging the same
 * functions as "undocumented" on every subsequent PR.
 *
 * The snapshot update only runs on pushes to the default branch
 * (main/master) — not on feature branches.
 */

async function handlePush({ octokit, context, inputs }) {
  const { repo } = context;

  // Only update snapshot on pushes to the default branch
  // Pushes to feature branches are handled by PR events instead
  const pushedBranch = context.ref.replace('refs/heads/', '');
  const { data: repoData } = await octokit.rest.repos.get({
    owner: repo.owner,
    repo: repo.repo,
  });
  const defaultBranch = repoData.default_branch;

  if (pushedBranch !== defaultBranch) {
    core.info(`Push to ${pushedBranch} (not default branch ${defaultBranch}) — skipping snapshot update`);
    return;
  }

  core.info(`Push to default branch ${defaultBranch} — updating snapshot`);

  const cwd = process.cwd();

  try {
    const config = loadConfig(cwd, inputs.configPath);
    const scanResult = await scanRepository(cwd, config);

    if (scanResult.totalFound === 0) {
      core.info('No trackable files found. Check docsync.yaml track patterns.');
      core.setOutput('files-analyzed', '0');
      core.setOutput('drift-score', '0');
      core.setOutput('drift-detected', 'false');
      return;
    }
    core.info(`Scanning ${scanResult.totalFound} file(s)...`);
    const parsedFiles = await parseFiles(scanResult.files);

    // Run drift check against current snapshot to report status
    if (snapshotExists(cwd)) {
      const snapshot = readSnapshot(cwd);
      if (snapshot) {
        const driftReport = analyzeDrift(snapshot, parsedFiles, cwd);
        core.info(`Drift score before snapshot update: ${driftReport.driftScore}/100`);

        await reporter.writeSummary({
          status: driftReport.hasDrift ? 'drift_detected' : 'in_sync',
          driftReport,
          pullNumber: null,
          companionPR: null,
          generationSummary: null,
        });
      }
    }

    // Update the snapshot to reflect the current state
    writeSnapshot(cwd, parsedFiles, { repoRoot: cwd });
    core.info(`Snapshot updated: ${parsedFiles.length} file(s), ${parsedFiles.reduce((s, f) => s + f.constructCount, 0)} construct(s)`);

    core.setOutput('files-analyzed', String(parsedFiles.length));
    core.setOutput('drift-score', '0');
    core.setOutput('drift-detected', 'false');

  } catch (error) {
    core.setFailed(`Push handler failed: ${error.message}`);
  }
}

module.exports = { handlePush };
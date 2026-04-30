'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const { parseFile } = require('../core/parser');
const { analyzeDrift } = require('../core/drift');
const { readSnapshot } = require('../core/snapshot');
const {
  getPRFiles,
  getFileContent,
  getDefaultBranch,
  createBranch,
  commitFile,
  createPullRequest,
  postPRComment,
  getBranchSha,
} = require('./client');

/**
 * PR PROCESSOR — THE HEART OF DOCSYNC'S AUTOMATION
 *
 * This module orchestrates the entire automated documentation workflow
 * when a Pull Request is opened or updated.
 *
 * THE FLOW:
 *
 * 1. Receive PR event (owner, repo, PR number, installation ID)
 * 2. Fetch all files changed in the PR
 * 3. Filter to only JS/TS files (the ones DocSync can parse)
 * 4. Download current content of each changed file
 * 5. Write files to a temporary directory
 * 6. Run the parser on these files (Part 2)
 * 7. Load the repo's snapshot from disk (Part 3)
 * 8. Run drift analysis (Part 3)
 * 9. If drift detected above threshold:
 *    a. Generate updated documentation (placeholder for Part 5)
 *    b. Create a new branch in the repo
 *    c. Commit the updated docs to that branch
 *    d. Open a companion PR targeting the same base branch
 *    e. Post a detailed comment on the ORIGINAL PR
 * 10. If no drift: post a green "docs in sync" comment
 *
 * SECURITY DESIGN:
 * - Temporary files are written to the OS temp directory
 *   (os.tmpdir()), not to the user's repo. This prevents
 *   any possibility of polluting the repo with temp files.
 * - Temp directory is cleaned up after processing regardless
 *   of success or failure (using try/finally).
 * - No user-provided data is ever executed — only parsed.
 */

// File extensions DocSync can process
const PROCESSABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/**
 * Main entry point — processes a single PR event.
 *
 * @param {object} params
 * @param {Octokit} params.octokit - Authenticated Octokit instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {number} params.pullNumber - PR number
 * @param {string} params.headSha - The HEAD commit SHA of the PR branch
 * @param {string} params.baseBranch - The branch the PR targets (e.g., 'main')
 * @param {string} params.prTitle - The PR title (used in companion PR)
 * @param {string} params.repoFullName - 'owner/repo' format
 * @returns {Promise<ProcessResult>}
 */
async function processPR({
  octokit,
  owner,
  repo,
  pullNumber,
  headSha,
  baseBranch,
  prTitle,
  repoFullName,
}) {
  logger.header(`Processing PR #${pullNumber} — ${repoFullName}`);

  // Step 1: Get changed files in this PR
  const allChangedFiles = await getPRFiles(octokit, owner, repo, pullNumber);
  logger.info(`PR #${pullNumber} changed ${allChangedFiles.length} file(s)`);

  // Step 2: Filter to only processable files
  // We ignore deleted files (nothing to parse), binary files, and non-code files
  const codeFiles = allChangedFiles.filter(file =>
    file.status !== 'removed' &&
    PROCESSABLE_EXTENSIONS.has(path.extname(file.filename).toLowerCase())
  );

  if (codeFiles.length === 0) {
    logger.info(`PR #${pullNumber}: No JS/TS files changed. Nothing for DocSync to process.`);
    return { action: 'skipped', reason: 'no_code_files' };
  }

  logger.info(`Found ${codeFiles.length} JS/TS file(s) to analyze`);

  // Step 3: Download file contents to a temporary directory
  // We use a unique temp directory per PR to avoid conflicts
  // if multiple PRs are processed simultaneously (concurrent safety)
  const tempDir = path.join(os.tmpdir(), `docsync-pr-${pullNumber}-${Date.now()}`);
  await fs.ensureDir(tempDir);

  logger.info(`Writing files to temp directory: ${tempDir}`);

  let result;

  try {
    // Download and write each changed file
    const downloadedFiles = await downloadPRFiles(
      octokit, owner, repo, codeFiles, headSha, tempDir
    );

    if (downloadedFiles.length === 0) {
      logger.warn(`PR #${pullNumber}: All file downloads failed.`);
      return { action: 'skipped', reason: 'download_failed' };
    }

    // Step 4: Parse the downloaded files using our Part 2 parser
    logger.info('Parsing changed files...');
    const parsedFiles = [];

    for (const filePath of downloadedFiles) {
      const parsed = await parseFile(filePath);
      if (parsed) parsedFiles.push(parsed);
    }

    if (parsedFiles.length === 0) {
      logger.info(`PR #${pullNumber}: No parseable constructs found.`);
      return { action: 'skipped', reason: 'no_constructs' };
    }

    logger.success(`Parsed ${parsedFiles.length} file(s) from PR`);

    // Step 5: Load the repo's existing snapshot
    // The snapshot lives in the base branch of the repo
    const snapshot = await loadRepoSnapshot(
      octokit, owner, repo, baseBranch
    );

    // Step 6: Run drift analysis
    const driftReport = analyzeDrift(
      snapshot,
      parsedFiles,
      tempDir
    );

    logger.info(`Drift score: ${driftReport.driftScore}/100`);

    // Step 7: Act on drift results
    if (driftReport.driftScore === 0 || !driftReport.hasDrift) {
      // No drift — post a positive status comment
      await postNoDriftComment(octokit, owner, repo, pullNumber);
      result = { action: 'no_drift', driftScore: 0 };

    } else {
      // Drift detected — open a companion PR
      result = await handleDriftDetected({
        octokit,
        owner,
        repo,
        pullNumber,
        baseBranch,
        prTitle,
        driftReport,
        parsedFiles,
      });
    }

  } finally {
    // ALWAYS clean up temp files — even if an error occurred.
    // The 'finally' block runs regardless of whether 'try' succeeded or threw.
    // This prevents temp directory accumulation that would eventually fill disk.
    try {
      await fs.remove(tempDir);
      logger.info('Cleaned up temporary files');
    } catch (cleanupError) {
      logger.warn(`Temp cleanup failed: ${cleanupError.message}`);
      // Don't re-throw — cleanup failure shouldn't mask the original result
    }
  }

  return result;
}

/**
 * Downloads changed PR files from GitHub to the local temp directory.
 * Preserves the original directory structure within the temp dir.
 *
 * Why preserve directory structure?
 * Because our parser uses relative imports to understand module relationships.
 * If we flatten all files into one directory, relative imports break and
 * the parser loses context.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {PRFile[]} files
 * @param {string} ref - Git ref to download from (the PR's HEAD commit)
 * @param {string} tempDir
 * @returns {Promise<string[]>} Array of local file paths
 */
async function downloadPRFiles(octokit, owner, repo, files, ref, tempDir) {
  const downloadedPaths = [];

  for (const file of files) {
    try {
      const content = await getFileContent(octokit, owner, repo, file.filename, ref);

      if (content === null) {
        logger.warn(`File not found at ref: ${file.filename}`);
        continue;
      }

      // Write to temp dir preserving the original path structure
      const localPath = path.join(tempDir, file.filename);
      await fs.outputFile(localPath, content, 'utf8');
      downloadedPaths.push(localPath);

      logger.info(`Downloaded: ${file.filename}`);

    } catch (error) {
      logger.warn(`Failed to download ${file.filename}: ${error.message}`);
      // Continue with other files — partial processing is better than nothing
    }
  }

  return downloadedPaths;
}

/**
 * Attempts to load the repository's DocSync snapshot from GitHub.
 * The snapshot is stored in .docsync/snapshot.json in the base branch.
 *
 * If no snapshot exists, returns an empty snapshot.
 * All constructs will be treated as "new" and score 80 each.
 * This is the correct behavior — a repo with no snapshot has undocumented code.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @returns {Promise<Snapshot>}
 */
async function loadRepoSnapshot(octokit, owner, repo, branch) {
  try {
    const content = await getFileContent(
      octokit, owner, repo, '.docsync/snapshot.json', branch
    );

    if (!content) {
      logger.warn('No snapshot found in repo. Treating all constructs as undocumented.');
      return buildEmptySnapshot();
    }

    const snapshot = JSON.parse(content);
    logger.success('Loaded snapshot from repo');
    return snapshot;

  } catch (error) {
    logger.warn(`Could not load snapshot: ${error.message}. Using empty baseline.`);
    return buildEmptySnapshot();
  }
}

/**
 * Returns an empty snapshot object.
 * Used when no snapshot exists in the repo.
 *
 * @returns {Snapshot}
 */
function buildEmptySnapshot() {
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    totalFiles: 0,
    totalConstructs: 0,
    files: {},
  };
}

/**
 * Handles the case where drift was detected in a PR.
 * Creates a companion PR with documentation updates.
 *
 * @param {object} params
 * @returns {Promise<ProcessResult>}
 */
async function handleDriftDetected({
  octokit,
  owner,
  repo,
  pullNumber,
  baseBranch,
  prTitle,
  driftReport,
  parsedFiles,
}) {
  logger.header(`Drift detected (score: ${driftReport.driftScore}/100) — creating companion PR`);

  // Generate the documentation content
  // In Part 5, this will call the Claude API.
  // For now, we generate a structured Markdown report of what changed.
  const docContent = generateDriftDocumentation(driftReport, parsedFiles, pullNumber);

  // Create a unique branch name for the companion PR
  // Format: docsync/pr-{number}-{timestamp}
  // Why include timestamp? In case the PR is updated and DocSync runs again —
  // we don't want branch name collisions.
  const companionBranch = `docsync/pr-${pullNumber}-${Date.now()}`;

  try {
    // Get the SHA of the base branch to branch from
    const baseSha = await getBranchSha(octokit, owner, repo, baseBranch);

    // Create the companion branch
    await createBranch(octokit, owner, repo, companionBranch, baseSha);
    logger.success(`Created branch: ${companionBranch}`);

    // Commit the documentation file to the companion branch
    const docFilePath = 'docs/drift-report.md';
    await commitFile(
      octokit,
      owner,
      repo,
      docFilePath,
      docContent,
      `docs: auto-update documentation for PR #${pullNumber} [DocSync]`,
      companionBranch
    );
    logger.success(`Committed documentation to ${companionBranch}`);

    // Open the companion PR
    const companionPR = await createPullRequest(octokit, owner, repo, {
      title: `📄 DocSync: Update docs for PR #${pullNumber} — "${prTitle}"`,
      body: buildCompanionPRBody(driftReport, pullNumber),
      head: companionBranch,
      base: baseBranch,
    });
    logger.success(`Opened companion PR #${companionPR.number}: ${companionPR.html_url}`);

    // Post a comment on the original PR linking to the companion
    await postDriftComment(
      octokit, owner, repo, pullNumber, driftReport, companionPR
    );

    return {
      action: 'companion_pr_created',
      driftScore: driftReport.driftScore,
      companionPRNumber: companionPR.number,
      companionPRUrl: companionPR.html_url,
    };

  } catch (error) {
    logger.error(`Failed to create companion PR: ${error.message}`);

    // Even if PR creation fails, post a comment warning about drift
    try {
      await postDriftWarningComment(octokit, owner, repo, pullNumber, driftReport);
    } catch (commentError) {
      logger.error(`Also failed to post comment: ${commentError.message}`);
    }

    return {
      action: 'drift_detected_pr_failed',
      driftScore: driftReport.driftScore,
      error: error.message,
    };
  }
}

/**
 * Generates the documentation content for the companion PR.
 * In Part 5, this will be replaced with Claude API-generated prose.
 * For now, it produces a structured Markdown drift report.
 *
 * @param {DriftReport} driftReport
 * @param {ParsedFile[]} parsedFiles
 * @param {number} pullNumber
 * @returns {string} Markdown content
 */
function generateDriftDocumentation(driftReport, parsedFiles, pullNumber) {
  const now = new Date().toISOString();
  const lines = [];

  lines.push(`# Documentation Update — PR #${pullNumber}`);
  lines.push(`> Auto-generated by DocSync on ${now}`);
  lines.push('');
  lines.push(`**Drift Score:** ${driftReport.driftScore}/100`);
  lines.push(`**Files Affected:** ${driftReport.summary.filesAffected}`);
  lines.push(`**Total Changes:** ${driftReport.summary.totalChanges}`);
  lines.push('');
  lines.push('## Changes Detected');
  lines.push('');

  for (const fileReport of driftReport.files) {
    const displayPath = fileReport.fileKey.split('/').slice(-2).join('/');
    lines.push(`### \`${displayPath}\` — Drift Score: ${fileReport.driftScore}/100`);
    lines.push('');

    for (const change of fileReport.changes) {
      const icon = change.type.includes('DELETED') ? '🔴' :
                   change.type.includes('ADDED') ? '🟢' : '🟡';
      lines.push(`- ${icon} **${change.type}**: ${change.detail}`);

      if (change.previous?.signature && change.current?.signature) {
        lines.push(`  - **Before:** \`${change.previous.signature}\``);
        lines.push(`  - **After:** \`${change.current.signature}\``);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*This file was auto-generated by [DocSync](https://github.com/ishwar-prog/docsync).*');
  lines.push('*Review and update the documentation sections above before merging.*');

  return lines.join('\n');
}

/**
 * Builds the body for the companion PR.
 *
 * @param {DriftReport} driftReport
 * @param {number} sourcePRNumber
 * @returns {string} Markdown PR body
 */
function buildCompanionPRBody(driftReport, sourcePRNumber) {
  return `## 📄 DocSync — Automated Documentation Update

This PR was automatically created by **DocSync** because PR #${sourcePRNumber} introduced code changes that caused documentation drift.

### Drift Summary

| Metric | Value |
|--------|-------|
| Drift Score | **${driftReport.driftScore}/100** |
| Files Affected | ${driftReport.summary.filesAffected} |
| Total Changes | ${driftReport.summary.totalChanges} |

### What Changed

${Object.entries(driftReport.summary.byType)
    .map(([type, count]) => `- **${type}**: ${count} occurrence(s)`)
    .join('\n')}

### How to Review

1. Check \`docs/drift-report.md\` for the detailed change analysis
2. Update any documentation sections that need human judgment
3. Merge this PR **alongside** or **after** PR #${sourcePRNumber}

---
*🤖 Generated by [DocSync](https://github.com/ishwar-prog/docsync) — Auto-updating docs that stay true to your code*`;
}

/**
 * Posts a comment on the original PR when drift is detected.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {DriftReport} driftReport
 * @param {PullRequest} companionPR
 * @returns {Promise<void>}
 */
async function postDriftComment(octokit, owner, repo, pullNumber, driftReport, companionPR) {
  const scoreBar = '█'.repeat(Math.round(driftReport.driftScore / 10)) +
                   '░'.repeat(10 - Math.round(driftReport.driftScore / 10));

  const body = `## 🔍 DocSync — Documentation Drift Detected

This PR changes code that has documentation implications.

**Drift Score:** \`${scoreBar}\` ${driftReport.driftScore}/100

### What DocSync Found

${driftReport.files.map(f => {
    const displayPath = f.fileKey.split('/').slice(-2).join('/');
    return `**\`${displayPath}\`** (${f.driftScore}/100)\n` +
      f.changes.map(c => `  - ${c.detail}`).join('\n');
  }).join('\n\n')}

### Action Taken

✅ DocSync has automatically opened **PR #${companionPR.number}** with updated documentation.

👉 [View Documentation PR #${companionPR.number}](${companionPR.html_url})

Please review and merge the documentation PR alongside this one.

---
*🤖 [DocSync](https://github.com/ishwar-prog/docsync) — Docs that stay true to your code*`;

  await postPRComment(octokit, owner, repo, pullNumber, body);
}

/**
 * Posts a comment when no drift is detected — positive confirmation.
 */
async function postNoDriftComment(octokit, owner, repo, pullNumber) {
  const body = `## ✅ DocSync — Docs In Sync

No documentation drift detected in this PR. Your documentation accurately describes the changed code.

${'░'.repeat(10)} 0/100

---
*🤖 [DocSync](https://github.com/ishwar-prog/docsync)*`;

  await postPRComment(octokit, owner, repo, pullNumber, body);
}

/**
 * Posts a warning comment when drift is detected but companion PR creation failed.
 */
async function postDriftWarningComment(octokit, owner, repo, pullNumber, driftReport) {
  const body = `## ⚠️ DocSync — Documentation Drift Detected

Drift score: **${driftReport.driftScore}/100**

DocSync detected documentation drift but was unable to automatically create a companion PR.
Please review the documentation manually before merging.

---
*🤖 [DocSync](https://github.com/ishwar-prog/docsync)*`;

  await postPRComment(octokit, owner, repo, pullNumber, body);
}

module.exports = { processPR };
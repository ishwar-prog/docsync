'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const core = require('@actions/core');

const { analyzeDrift } = require('../core/drift');
const {
  generateDocumentationForDrift,
  renderDocumentationAsMarkdown,
} = require('../core/generator');
const { reporter } = require('./reporter');

/**
 * PR HANDLER FOR GITHUB ACTIONS
 *
 * Handles pull_request and pull_request_target events.
 *
 * CRITICAL SECURITY NOTE — pull_request_target:
 *
 * When triggered by pull_request_target, this action runs with
 * write permissions (can create PRs, post comments). The workflow
 * MUST use actions/checkout to check out the BASE branch (main),
 * not the PR branch. Never run untrusted PR code with write permissions.
 *
 * Our workflow is designed correctly — we check out the base branch
 * and then use the GitHub API to get the PR's changed files.
 * We ANALYZE the PR code (read-only) but NEVER EXECUTE it.
 *
 * This is the same pattern used by Dependabot, Renovate, and
 * every other bot that needs write access from fork PRs.
 *
 * EXECUTION FLOW:
 *
 * 1. Extract PR context from github.context
 * 2. Skip conditions (draft, bot PR, no code files)
 * 3. Get list of changed files via GitHub API
 * 4. Download changed files to temp directory
 * 5. Load snapshot from base branch (already checked out)
 * 6. Parse changed files with Tree-sitter
 * 7. Run drift analysis
 * 8. If drift: generate docs with AI, create companion PR, post comment
 * 9. Set action outputs for downstream steps
 * 10. Write Actions summary
 */

const PROCESSABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/**
 * Main PR event handler.
 *
 * @param {object} params
 * @param {Octokit} params.octokit
 * @param {github.context} params.context
 * @param {ActionInputs} params.inputs
 */
async function handlePullRequest({ octokit, context, inputs }) {
  const { repo } = context;
  const pr = context.payload.pull_request;

  if (!pr) {
    core.warning('No pull_request payload found in context. Skipping.');
    return;
  }

  const pullNumber = pr.number;
  // Default outputs for all exit paths
  core.setOutput('drift-detected', 'false');
  core.setOutput('drift-score', '0');
  core.setOutput('files-analyzed', '0');
  core.setOutput('constructs-found', '0');
  core.setOutput('companion-pr-number', '');
  core.setOutput('companion-pr-url', '');

  const prTitle = pr.title;
  const baseBranch = pr.base.ref;
  const headSha = pr.head.sha;

  core.info(`Processing PR #${pullNumber}: "${prTitle}"`);
  core.info(`Base: ${baseBranch} ← Head: ${pr.head.ref}`);

  // ── Skip Conditions ──────────────────────────────────────────────────────

  // Skip draft PRs
  if (pr.draft) {
    core.info(`PR #${pullNumber} is a draft — skipping`);
    return;
  }

  // Skip DocSync's own companion PRs — prevents infinite loops
  // Check both branch prefix AND sender type for security
  const isDocSyncBranch = pr.head.ref.startsWith('docsync/');
  const isBotSender = context.payload.sender?.type === 'Bot';

  if (isDocSyncBranch && isBotSender) {
    core.info(`PR #${pullNumber} is from DocSync bot — skipping to prevent loop`);
    return;
  }

  // ── Get Changed Files ────────────────────────────────────────────────────

  core.info('Fetching changed files...');
  const allChangedFiles = await getPRFiles(octokit, repo.owner, repo.repo, pullNumber);
  core.info(`PR changed ${allChangedFiles.length} file(s) total`);

  // Filter to only processable code files
  const codeFiles = allChangedFiles.filter(file =>
    file.status !== 'removed' &&
    PROCESSABLE_EXTENSIONS.has(path.extname(file.filename).toLowerCase())
  );

  if (codeFiles.length === 0) {
    core.info('No JS/TS files changed — nothing for DocSync to analyze');
    return;
  }

  core.info(`Found ${codeFiles.length} JS/TS file(s) to analyze`);

  // ── Download Changed Files ───────────────────────────────────────────────

  // Write to a temp directory — never to the checked-out repo
  // This prevents any possibility of polluting the workspace
  const tempDir = path.join(os.tmpdir(), `docsync-action-pr${pullNumber}-${Date.now()}`);
  await fs.ensureDir(tempDir);

  let processResult;

  try {
    const downloadedFiles = await downloadFiles(
      octokit, repo.owner, repo.repo, codeFiles, headSha, tempDir
    );

    if (downloadedFiles.length === 0) {
      core.warning('All file downloads failed. Cannot analyze this PR.');
      return;
    }

    // ── Load Snapshot ──────────────────────────────────────────────────────

    // The snapshot is on the base branch, which is checked out in the workspace
    // process.cwd() in a GitHub Action is the repo root
    const cwd = process.cwd();
    const snapshot = loadSnapshot(cwd);

    // ── Parse Changed Files ────────────────────────────────────────────────

    core.info('Parsing changed files with Tree-sitter...');
    const parsedFiles = [];

    for (const filePath of downloadedFiles) {
      const { parseFile } = require('../core/parser');
      const parsed = await parseFile(filePath);
      if (parsed) parsedFiles.push(parsed);
    }

    core.info(`Parsed ${parsedFiles.length} file(s)`);

    const totalConstructs = parsedFiles.reduce((sum, f) => sum + f.constructCount, 0);
    core.setOutput('files-analyzed', String(parsedFiles.length));
    core.setOutput('constructs-found', String(totalConstructs));

    if (parsedFiles.length === 0) {
      core.info('No parseable constructs found in changed files');
      return;
    }

    // ── Run Drift Analysis ─────────────────────────────────────────────────

    core.info('Running drift analysis...');
    const driftReport = analyzeDrift(snapshot, parsedFiles, tempDir);

    core.info(`Drift score: ${driftReport.driftScore}/100 (threshold: ${inputs.driftThreshold}/100)`);
    core.setOutput('drift-score', String(driftReport.driftScore));
    core.setOutput('drift-detected', String(driftReport.driftScore >= inputs.driftThreshold));

    // ── Act on Results ─────────────────────────────────────────────────────

    if (!driftReport.hasDrift) {
      core.info('✅ Docs are in sync — no action needed');

      if (inputs.postComment) {
        await postNoDriftComment(octokit, repo.owner, repo.repo, pullNumber);
      }

      await reporter.writeSummary({
        status: 'in_sync',
        driftReport,
        pullNumber,
      });

      return;
    }

    if (driftReport.hasDrift && driftReport.driftScore < inputs.driftThreshold) {
      core.info(`✅ Drift detected (${driftReport.driftScore}/100), but below threshold (${inputs.driftThreshold}/100) — no action needed`);

      await reporter.writeSummary({
        status: 'drift_below_threshold',
        driftReport,
        pullNumber,
      });

      return;
    }

    // Drift detected above threshold
    core.warning(`Drift detected: ${driftReport.driftScore}/100 exceeds threshold of ${inputs.driftThreshold}/100`);

    // Generate AI documentation if API key is available
    let generationSummary = null;
    const hasAIKey = process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY;

    if (hasAIKey) {
      core.info('Generating documentation with AI...');
      try {
        generationSummary = await generateDocumentationForDrift(parsedFiles, driftReport);
        core.info(`Generated docs for ${generationSummary.filesProcessed} file(s)`);
      } catch (genError) {
        core.warning(`AI generation failed: ${genError.message}. Proceeding with drift report only.`);
      }
    } else {
      core.info('No AI key — skipping documentation generation');
    }

    // Build the documentation content
    const docContent = buildDocumentationContent(
      driftReport, parsedFiles, pullNumber, generationSummary
    );

    // Create companion PR if enabled
    let companionPR = null;
    if (inputs.openCompanionPR) {
      companionPR = await createCompanionPR({
        octokit,
        owner: repo.owner,
        repo: repo.repo,
        pullNumber,
        prTitle,
        baseBranch,
        docContent,
        driftReport,
        generationSummary,
      });

      if (companionPR) {
        core.setOutput('companion-pr-number', String(companionPR.number));
        core.setOutput('companion-pr-url', companionPR.html_url);
        core.info(`✅ Companion PR #${companionPR.number}: ${companionPR.html_url}`);
      }
    }

    // Post comment on original PR
    if (inputs.postComment) {
      await postDriftComment(
        octokit, repo.owner, repo.repo, pullNumber, driftReport, companionPR
      );
    }

    // Write Actions summary
    await reporter.writeSummary({
      status: 'drift_detected',
      driftReport,
      pullNumber,
      companionPR,
      generationSummary,
    });

    processResult = {
      driftScore: driftReport.driftScore,
      companionPR,
    };

  } finally {
    // Always clean up temp files
    try {
      await fs.remove(tempDir);
    } catch {
      // Cleanup failure is non-fatal
    }
  }

  return processResult;
}

/**
 * Fetches all files changed in a PR, handling pagination.
 */
async function getPRFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner, repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    files.push(...response.data);
    if (response.data.length < 100) break;
    page++;
  }

  return files;
}

/**
 * Downloads changed PR files to a temp directory.
 * Preserves directory structure for accurate import resolution.
 */
async function downloadFiles(octokit, owner, repo, files, ref, tempDir) {
  const downloaded = [];

  for (const file of files) {
    try {
      const response = await octokit.rest.repos.getContent({
        owner, repo,
        path: file.filename,
        ref,
      });

      if (response.data.type !== 'file') continue;

      const content = Buffer.from(response.data.content, 'base64').toString('utf8');
      const localPath = path.join(tempDir, file.filename);
      await fs.outputFile(localPath, content, 'utf8');
      downloaded.push(localPath);
      core.info(`  Downloaded: ${file.filename}`);

    } catch (error) {
      core.warning(`  Failed to download ${file.filename}: ${error.message}`);
    }
  }

  return downloaded;
}

/**
 * Loads the snapshot from the checked-out repo.
 * Falls back to empty snapshot if none exists.
 */
function loadSnapshot(cwd) {
  const snapshotPath = path.join(cwd, '.docsync', 'snapshot.json');

  if (!fs.pathExistsSync(snapshotPath)) {
    core.info('No snapshot found — treating all constructs as undocumented');
    return {
      version: 2,
      createdAt: new Date().toISOString(),
      totalFiles: 0,
      totalConstructs: 0,
      files: {},
    };
  }

  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const snapshot = JSON.parse(raw);
    core.info(`Snapshot loaded: ${snapshot.totalFiles} file(s), ${snapshot.totalConstructs} construct(s)`);
    return snapshot;
  } catch (error) {
    core.warning(`Snapshot corrupted: ${error.message}. Using empty baseline.`);
    return { version: 2, createdAt: new Date().toISOString(), totalFiles: 0, totalConstructs: 0, files: {} };
  }
}

/**
 * Builds the full documentation content for the companion PR.
 */
function buildDocumentationContent(driftReport, parsedFiles, pullNumber, generationSummary) {
  const lines = [];

  if (generationSummary && generationSummary.results.length > 0) {
    // AI-generated documentation
    for (const result of generationSummary.results) {
      const markdown = renderDocumentationAsMarkdown(result, result.filePath);
      lines.push(markdown);
      lines.push('\n---\n');
    }
  } else {
    // Fallback: structured drift report
    lines.push(`# Documentation Update — PR #${pullNumber}\n`);
    lines.push(`> Auto-generated by DocSync on ${new Date().toISOString()}\n`);
    lines.push(`**Drift Score:** ${driftReport.driftScore}/100\n`);

    for (const fileReport of driftReport.files) {
      const displayPath = fileReport.fileKey.split('/').slice(-2).join('/');
      lines.push(`## \`${displayPath}\`\n`);
      for (const change of fileReport.changes) {
        lines.push(`- ${change.detail}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Creates the companion documentation PR.
 */
async function createCompanionPR({
  octokit, owner, repo, pullNumber, prTitle,
  baseBranch, docContent, driftReport, generationSummary,
}) {
  try {
    // Get base branch SHA
    const { data: branchData } = await octokit.rest.repos.getBranch({
      owner, repo, branch: baseBranch,
    });
    const baseSha = branchData.commit.sha;

    // Create companion branch
    const companionBranch = `docsync/pr-${pullNumber}-${Date.now()}`;
    await octokit.rest.git.createRef({
      owner, repo,
      ref: `refs/heads/${companionBranch}`,
      sha: baseSha,
    });
    core.info(`Created branch: ${companionBranch}`);

    // Commit documentation file
    await octokit.rest.repos.createOrUpdateFileContents({
      owner, repo,
      path: 'docs/api-reference.md',
      message: `docs: auto-generate documentation for PR #${pullNumber} [DocSync]`,
      content: Buffer.from(docContent, 'utf8').toString('base64'),
      branch: companionBranch,
    });
    core.info('Committed documentation file');

    // Build PR body
    const aiInfo = generationSummary
      ? `\n| AI Model | ${generationSummary.results[0]?.model || 'Llama 3.3 70B'} |`
      : '';

    const prBody = `## 📄 DocSync — Automated Documentation Update

This PR was automatically created by **DocSync** because PR #${pullNumber} introduced code changes that caused documentation drift.

### Drift Summary

| Metric | Value |
|--------|-------|
| Drift Score | **${driftReport.driftScore}/100** |
| Files Affected | ${driftReport.summary.filesAffected} |
| Total Changes | ${driftReport.summary.totalChanges} |${aiInfo}

### Changes Detected

${Object.entries(driftReport.summary.byType)
      .map(([type, count]) => `- **${type}**: ${count} occurrence(s)`)
      .join('\n')}

### Review Instructions

1. Open \`docs/api-reference.md\` to see the generated documentation
2. Review for accuracy — AI documentation is thorough but not omniscient
3. Make any necessary corrections
4. Merge this PR alongside or after PR #${pullNumber}

---
*🤖 Generated by [DocSync](https://github.com/ishwar-prog/docsync) — Docs that stay true to your code*`;

    // Open the PR
    const { data: companionPR } = await octokit.rest.pulls.create({
      owner, repo,
      title: `📄 DocSync: Update docs for PR #${pullNumber} — "${prTitle}"`,
      body: prBody,
      head: companionBranch,
      base: baseBranch,
      draft: false,
    });

    return companionPR;

  } catch (error) {
    core.error(`Failed to create companion PR: ${error.message}`);
    return null;
  }
}

/**
 * Posts a drift detection comment on the original PR.
 */
async function postDriftComment(octokit, owner, repo, pullNumber, driftReport, companionPR) {
  const scoreBar = '█'.repeat(Math.round(driftReport.driftScore / 10)) +
                   '░'.repeat(10 - Math.round(driftReport.driftScore / 10));

  const companionInfo = companionPR
    ? `\n✅ **Companion PR Created:** [PR #${companionPR.number}](${companionPR.html_url})`
    : '\n⚠️ Companion PR creation failed — please update docs manually.';

  const body = `## 🔍 DocSync — Documentation Drift Detected

This PR changes code that has documentation implications.

| | |
|---|---|
| **Drift Score** | \`${scoreBar}\` **${driftReport.driftScore}/100** |
| **Threshold** | ${driftReport.summary.filesAffected > 0 ? '⚠️ Exceeded' : '✅ OK'} |
| **Files Affected** | ${driftReport.summary.filesAffected} |
| **Changes** | ${driftReport.summary.totalChanges} |

### What Changed

${driftReport.files.slice(0, 5).map(f => {
    const displayPath = f.fileKey.split('/').slice(-2).join('/');
    return `**\`${displayPath}\`** (score: ${f.driftScore}/100)\n` +
      f.changes.slice(0, 3).map(c => `  - ${c.detail}`).join('\n');
  }).join('\n\n')}
${driftReport.files.length > 5 ? `\n*...and ${driftReport.files.length - 5} more file(s)*` : ''}

${companionInfo}

---
*🤖 [DocSync](https://github.com/ishwar-prog/docsync) — Docs that stay true to your code*`;

  try {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: pullNumber,
      body,
    });
  } catch (error) {
    core.warning(`Failed to post PR comment: ${error.message}`);
  }
}

/**
 * Posts a positive "docs in sync" comment.
 */
async function postNoDriftComment(octokit, owner, repo, pullNumber) {
  const body = `## ✅ DocSync — Documentation In Sync

No documentation drift detected in this PR.

| | |
|---|---|
| **Drift Score** | \`░░░░░░░░░░\` **0/100** |
| **Status** | ✅ Docs accurately describe the changed code |

---
*🤖 [DocSync](https://github.com/ishwar-prog/docsync)*`;

  try {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: pullNumber,
      body,
    });
  } catch (error) {
    core.warning(`Failed to post PR comment: ${error.message}`);
  }
}

module.exports = { handlePullRequest };
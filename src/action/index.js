'use strict';

/**
 * ACTION ENTRY POINT
 *
 * This file is what GitHub runs when someone uses DocSync as an Action.
 * It is kept deliberately thin — it reads inputs, determines the event
 * type, and delegates to the appropriate handler.
 *
 * The thin entry point pattern is critical here because:
 * 1. Actions have a 6-hour timeout — long-running logic should fail fast
 *    with clear errors, not hang silently
 * 2. Different event types (pull_request, push) need completely different
 *    handling — routing here keeps handlers focused
 * 3. Input validation at the boundary prevents confusing errors deep in logic
 *
 * EXECUTION ENVIRONMENT:
 * - Runs on GitHub-hosted Ubuntu runners (fresh VM per run)
 * - Node.js 20 is pre-installed
 * - The entire repo is NOT checked out by default — we do that explicitly
 * - Working directory is the root of the runner workspace
 * - All secrets are available as environment variables
 *
 * IMPORTANT: process.exit() terminates the entire action immediately.
 * core.setFailed() marks the action as failed but allows cleanup to run.
 * Always prefer core.setFailed() over process.exit(1) in actions.
 */

const core = require('@actions/core');
const github = require('@actions/github');

// Import event-specific handlers
const { handlePullRequest } = require('./pr-handler');
const { handlePush } = require('./push-handler');

async function run() {
  try {
    // ── Read and Validate Inputs ─────────────────────────────────────────

    const inputs = readInputs();
    validateInputs(inputs);

    // Set secrets so they're masked in all future log output
    // CRITICAL: Do this BEFORE any logging that might accidentally
    // include these values in output
    if (inputs.groqApiKey) core.setSecret(inputs.groqApiKey);
    if (inputs.anthropicApiKey) core.setSecret(inputs.anthropicApiKey);

    // ── Set Up Environment ───────────────────────────────────────────────

    // Inject API keys into process.env so existing DocSync modules
    // (generator.js, etc.) can read them via process.env.GROQ_API_KEY
    // without any modification
    if (inputs.groqApiKey) process.env.GROQ_API_KEY = inputs.groqApiKey;
    if (inputs.anthropicApiKey) process.env.ANTHROPIC_API_KEY = inputs.anthropicApiKey;
    process.env.NODE_ENV = 'production';

    // ── Log Run Context ──────────────────────────────────────────────────

    const { context } = github;
    core.info(`DocSync v${require('../../package.json').version}`);
    core.info(`Event: ${context.eventName}`);
    core.info(`Repository: ${context.repo.owner}/${context.repo.repo}`);
    core.info(`Ref: ${context.ref}`);
    core.info(`SHA: ${context.sha}`);
    core.info(`Drift threshold: ${inputs.driftThreshold}/100`);

    // ── Route to Event Handler ───────────────────────────────────────────

    const octokit = github.getOctokit(inputs.githubToken);

    switch (context.eventName) {
      case 'pull_request':
      case 'pull_request_target':
        await handlePullRequest({ octokit, context, inputs });
        break;

      case 'push':
        await handlePush({ octokit, context, inputs });
        break;

      default:
        core.warning(`DocSync: Unsupported event type '${context.eventName}'. Skipping.`);
        core.info('DocSync supports: pull_request, pull_request_target, push');
    }

  } catch (error) {
    // core.setFailed marks the action step as failed in the UI
    // and sets the exit code to 1 — which fails the workflow job
    // (unless the job has continue-on-error: true)
    core.setFailed(`DocSync failed: ${error.message}`);

    // In development, show the full stack trace for debugging
    if (process.env.RUNNER_DEBUG === '1') {
      core.error(error.stack);
    }
  }
}

/**
 * Reads all action inputs using the @actions/core toolkit.
 *
 * core.getInput() reads from the workflow's `with:` block.
 * It also reads from environment variables prefixed with INPUT_
 * (uppercase, hyphens replaced by underscores) — this allows
 * local testing without a GitHub Actions environment.
 *
 * @returns {ActionInputs}
 */
function readInputs() {
  return {
    githubToken: core.getInput('github-token', { required: true }),
    groqApiKey: core.getInput('groq-api-key') || '',
    anthropicApiKey: core.getInput('anthropic-api-key') || '',
    driftThreshold: parseInt(core.getInput('drift-threshold') || '75', 10),
    configPath: core.getInput('config-path') || 'docsync.yaml',
    openCompanionPR: core.getInput('open-companion-pr') !== 'false',
    postComment: core.getInput('post-comment') !== 'false',
  };
}

/**
 * Validates action inputs at the boundary.
 * Fails fast with clear error messages rather than cryptic failures later.
 *
 * @param {ActionInputs} inputs
 */
function validateInputs(inputs) {
  if (!inputs.githubToken) {
    throw new Error('github-token is required. Add it to your workflow with: github-token: ${{ secrets.GITHUB_TOKEN }}');
  }
  if (isNaN(inputs.driftThreshold) || inputs.driftThreshold < 0 || inputs.driftThreshold > 100) {
    throw new Error(`Invalid drift-threshold: "${inputs.driftThreshold}". Must be a number between 0 and 100.`);
  }

  const hasAIKey = inputs.groqApiKey || inputs.anthropicApiKey;
  if (!hasAIKey) {
    core.warning('No AI API key provided (groq-api-key or anthropic-api-key). Drift detection will work but documentation generation will be skipped.');
  }
}

// Run the action
run();
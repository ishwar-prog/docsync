'use strict';

require('dotenv').config();

const express = require('express');
const { Webhooks, createNodeMiddleware } = require('@octokit/webhooks');
const logger = require('../utils/logger');
const { getInstallationOctokit } = require('./client');
const { processPR } = require('./pr-processor');

/**
 * WEBHOOK SERVER ARCHITECTURE
 *
 * This Express server has one job: receive GitHub webhook events,
 * verify they are genuine (signature check), and route them to
 * the appropriate handler.
 *
 * SECURITY LAYERS:
 *
 * Layer 1 — HMAC Signature Verification:
 *   Every request is verified against the webhook secret before
 *   any processing begins. Forged requests are rejected at this layer.
 *
 * Layer 2 — Event Type Filtering:
 *   Only specific event types trigger processing. Unknown events
 *   are acknowledged (200 OK) but ignored. This prevents resource
 *   exhaustion from unexpected event types.
 *
 * Layer 3 — Async Processing with Error Isolation:
 *   Each webhook event is processed asynchronously. If processing
 *   fails, the error is caught and logged — the server does not crash.
 *   GitHub requires a 200 response within 10 seconds or it retries.
 *   We respond immediately and process asynchronously.
 *
 * WHY RESPOND IMMEDIATELY?
 *   GitHub's webhook delivery system waits up to 10 seconds for
 *   a response. If your server takes longer (e.g., calling Claude API,
 *   creating a PR), GitHub marks the delivery as failed and retries.
 *   This causes duplicate processing — the same PR gets two companion PRs.
 *
 *   The solution: respond 200 OK immediately, then process in the background.
 *   This is the "fire and forget with async processing" pattern.
 *   Used by Stripe, Twilio, and every production webhook consumer.
 */

/**
 * Creates and configures the webhook server.
 * Returns the configured Express app (not yet listening).
 *
 * @returns {express.Application}
 */
function createWebhookServer() {
  const app = express();

  // Validate required environment variables at startup
  // Fail fast — better to crash on startup with a clear error
  // than to silently misconfigure and fail mysteriously later
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error('GITHUB_WEBHOOK_SECRET is not set in .env');
    logger.info('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  // Initialize the Webhooks instance with our secret
  // This handles HMAC verification for every incoming request
  const webhooks = new Webhooks({
    secret: webhookSecret,
  });

  // ── Event Handlers ────────────────────────────────────────────────────────

  /**
   * Handler for pull_request events.
   *
   * GitHub sends this event for many PR actions:
   * opened, closed, reopened, synchronize (new commits pushed), labeled, etc.
   *
   * We only process 'opened' and 'synchronize' because:
   * - 'opened': new PR, check its changed files immediately
   * - 'synchronize': new commits pushed to an existing PR, re-check
   * - All other actions (labeled, assigned, etc.) don't affect code
   */
  webhooks.on('pull_request.opened', handlePullRequestEvent);
  webhooks.on('pull_request.synchronize', handlePullRequestEvent);

  /**
   * Handler for push events.
   * Useful for detecting drift on direct pushes to main (not through PRs).
   * We'll implement this fully in a later part.
   */
  webhooks.on('push', async ({ payload }) => {
    const branch = payload.ref?.replace('refs/heads/', '');
    logger.info(`Push to ${payload.repository?.full_name}:${branch} — ${payload.commits?.length || 0} commit(s)`);
    // Full push handling comes in Part 5
  });

  /**
   * Catch-all for any errors in event handling.
   * Without this, unhandled errors would crash the server.
   */
  webhooks.onError((error) => {
    logger.error(`Webhook processing error: ${error.message}`);
    if (process.env.NODE_ENV === 'development') {
      console.error(error);
    }
  });

  // ── Express Routes ────────────────────────────────────────────────────────

  /**
   * Health check endpoint.
   * Used by load balancers, uptime monitors, and deployment systems
   * to verify the server is running and healthy.
   *
   * Standard: returns 200 with a JSON status object.
   * Kubernetes, Railway, Render, and Fly.io all use this pattern.
   */
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'docsync-webhook',
      version: require('../../package.json').version,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  });

  /**
   * The main webhook endpoint.
   * All GitHub webhook deliveries arrive here as POST requests.
   *
   * createNodeMiddleware() from @octokit/webhooks handles:
   * 1. Reading the raw request body
   * 2. Verifying the HMAC-SHA256 signature
   * 3. Parsing the JSON payload
   * 4. Routing to the correct event handler
   * 5. Sending 200 OK response
   *
   * IMPORTANT: We must use the raw body for signature verification.
   * If Express parses the body first (e.g., via express.json()), it
   * reformats the JSON, which changes the string and breaks the signature.
   * createNodeMiddleware handles body reading internally for this reason.
   */
  app.use(createNodeMiddleware(webhooks, { path: '/webhook' }));

  // 404 handler for any other routes
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  // Global error handler — catches any unhandled Express errors
  app.use((error, req, res, next) => {
    logger.error(`Express error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Handles pull_request.opened and pull_request.synchronize events.
 *
 * @param {object} param0 - Webhook event object from @octokit/webhooks
 */
async function handlePullRequestEvent({ payload }) {
  const {
    action,
    pull_request: pr,
    repository,
    installation,
  } = payload;

  const owner = repository.owner.login;
  const repo = repository.name;
  const repoFullName = repository.full_name;
  const pullNumber = pr.number;
  const headSha = pr.head.sha;
  const baseBranch = pr.base.ref;
  const prTitle = pr.title;
  const installationId = installation?.id;

  logger.header(`PR Event: ${action} — #${pullNumber} in ${repoFullName}`);

  if (!installationId) {
    logger.error('No installation ID in webhook payload. Is the GitHub App installed on this repo?');
    return;
  }

  // Skip draft PRs — they're works in progress
  // Processing draft PRs would spam developers with premature doc checks
  if (pr.draft) {
    logger.info(`PR #${pullNumber} is a draft — skipping`);
    return;
  }

 // Skip PRs from DocSync bot — prevents infinite loops
// We check BOTH the branch prefix AND the sender type
// Branch prefix alone can be spoofed by contributors
const isDocSyncBranch = pr.head.ref.startsWith('docsync/');
const isBotSender = payload.sender?.type === 'Bot';

if (isDocSyncBranch && isBotSender) {
  logger.info(`PR #${pullNumber} is from DocSync bot — skipping to prevent loop`);
  return;
}

// Extra guard: if branch is docsync/ but sender is human, log a warning
// This means someone manually created a docsync/ branch — process it normally
if (isDocSyncBranch && !isBotSender) {
  logger.warn(`PR #${pullNumber} has docsync/ prefix but was opened by a human — processing normally`);
}

  try {
    // Get an authenticated Octokit instance for this installation
    const octokit = await getInstallationOctokit(installationId);

    // Process the PR — this is where all the real work happens
    const result = await processPR({
      octokit,
      owner,
      repo,
      pullNumber,
      headSha,
      baseBranch,
      prTitle,
      repoFullName,
    });

    logger.success(`PR #${pullNumber} processed: ${result.action}`);
    if (result.companionPRUrl) {
      logger.success(`Companion PR: ${result.companionPRUrl}`);
    }

  } catch (error) {
    // Log the error but don't re-throw — the server must keep running
    logger.error(`Failed to process PR #${pullNumber}: ${error.message}`);
    if (process.env.NODE_ENV === 'development') {
      console.error(error);
    }
  }
}

/**
 * Starts the webhook server.
 *
 * @param {number} port
 * @returns {http.Server}
 */
function startWebhookServer(port = 3000) {
  const app = createWebhookServer();

  const server = app.listen(port, () => {
    logger.header('DocSync Webhook Server');
    logger.newline();
    logger.success(`Server running on port ${port}`);
    logger.info(`Health check: http://localhost:${port}/health`);
    logger.info(`Webhook endpoint: http://localhost:${port}/webhook`);
    logger.newline();
    logger.info('Expose with ngrok: ngrok http ' + port);
    logger.info('Then update your GitHub App webhook URL with the ngrok URL + /webhook');
    logger.newline();
  });

  // Graceful shutdown — handles Ctrl+C and process termination signals
  // Without this, the server exits abruptly leaving connections open
  // This is critical for zero-downtime deployments
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received — shutting down gracefully');
    server.close(() => {
      logger.success('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received (Ctrl+C) — shutting down gracefully');
    server.close(() => {
      logger.success('Server closed');
      process.exit(0);
    });
  });

  return server;
}

module.exports = { createWebhookServer, startWebhookServer };
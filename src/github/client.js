'use strict';

const fs = require('fs');
const { App } = require('@octokit/app');
const { Octokit } = require('@octokit/rest');
const logger = require('../utils/logger');

/**
 * GITHUB APP AUTHENTICATION — HOW IT WORKS
 *
 * GitHub App authentication is more complex than a simple API token.
 * Here is the exact flow, because understanding it prevents hours of
 * debugging when something goes wrong:
 *
 * 1. Your GitHub App has a PRIVATE KEY (the .pem file).
 *    This key never leaves your server — it is used to SIGN tokens,
 *    never sent to GitHub directly.
 *
 * 2. To authenticate, you create a JWT (JSON Web Token) signed with
 *    your private key. The JWT contains your App ID and expires in 10 minutes.
 *    You send this JWT to GitHub as a Bearer token.
 *
 * 3. GitHub verifies the JWT using your app's PUBLIC key (which GitHub
 *    stores when you uploaded your private key). If valid, GitHub knows
 *    the request genuinely comes from your app.
 *
 * 4. You use this JWT to request an INSTALLATION ACCESS TOKEN —
 *    a short-lived token (1 hour) scoped to a specific repo installation.
 *    This is what you actually use for API calls.
 *
 * 5. When the installation token expires, you repeat steps 2-4.
 *    @octokit/app handles this rotation automatically.
 *
 * This two-step process (JWT → Installation Token) exists because:
 * - JWTs prove identity (who you are) but are short-lived
 * - Installation tokens prove authorization (what you can access)
 *   and are scoped to specific repos — limiting blast radius if leaked
 *
 * This is the OAuth2 "client credentials" flow adapted for GitHub Apps.
 * The same pattern is used by Google Cloud, AWS, and Azure service accounts.
 */

let appInstance = null;

/**
 * Returns the initialized GitHub App instance.
 * Uses singleton pattern — creates once, reuses across all webhook events.
 *
 * Why singleton? Creating a new App instance per request is expensive
 * (reads the .pem file, parses it, initializes cryptographic state).
 * A singleton does this once at startup and reuses the instance.
 *
 * @returns {App}
 */
function getApp() {
  if (appInstance) return appInstance;

  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (!privateKeyPath) {
    logger.error('GITHUB_APP_PRIVATE_KEY_PATH is not set in .env');
    process.exit(1);
  }

  let privateKey;
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch (error) {
    logger.error(`Cannot read GitHub App private key: ${error.message}`);
    logger.info(`Expected file at: ${privateKeyPath}`);
    logger.info('Download your private key from your GitHub App settings page');
    process.exit(1);
  }

  const appId = process.env.GITHUB_APP_ID;
  if (!appId) {
    logger.error('GITHUB_APP_ID is not set in .env');
    process.exit(1);
  }

  appInstance = new App({
    appId: parseInt(appId, 10),
    privateKey,
    // Octokit is the underlying HTTP client.
    // We configure it with our User-Agent string.
    // GitHub's API terms require a descriptive User-Agent.
    // This also helps GitHub's support team identify your app
    // in their logs if you ever need to contact them about rate limiting.
    Octokit: Octokit.defaults({
      userAgent: 'DocSync/0.1.0 (github.com/ishwar-prog/docsync)',
    }),
  });

  logger.success('GitHub App client initialized');
  return appInstance;
}

/**
 * Returns an authenticated Octokit instance for a specific installation.
 * This instance has permission to act on repos where the app is installed.
 *
 * @param {number} installationId - The installation ID from GitHub
 * @returns {Promise<Octokit>}
 */
async function getInstallationOctokit(installationId) {
  const app = getApp();
  // @octokit/app handles JWT creation, installation token request,
  // and automatic token refresh when the 1-hour token expires.
  return app.getInstallationOctokit(installationId);
}

/**
 * Fetches the list of files changed in a Pull Request.
 *
 * GitHub's PR files API is paginated — a PR can change thousands of files,
 * and GitHub returns at most 100 per page.
 * We handle pagination explicitly to get ALL changed files, not just the first 100.
 *
 * @param {Octokit} octokit
 * @param {string} owner - Repo owner (username or org)
 * @param {string} repo - Repo name
 * @param {number} pullNumber - PR number
 * @returns {Promise<PRFile[]>}
 */
async function getPRFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;

  // Paginate until GitHub returns fewer than 100 files
  // (indicating we've reached the last page)
  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });

    files.push(...response.data);

    // If we got fewer than 100, this is the last page
    if (response.data.length < 100) break;
    page++;
  }

  return files;
}

/**
 * Downloads the content of a specific file from a GitHub repo.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath - Path within the repo (e.g., 'src/api.js')
 * @param {string} ref - Git ref: branch name, commit SHA, or tag
 * @returns {Promise<string>} File content as UTF-8 string
 */
async function getFileContent(octokit, owner, repo, filePath, ref) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref,
    });

    // GitHub returns file content as base64-encoded string
    // We decode it to get the actual source code
    if (response.data.type !== 'file') {
      throw new Error(`Expected file, got ${response.data.type}`);
    }

    return Buffer.from(response.data.content, 'base64').toString('utf8');

  } catch (error) {
    if (error.status === 404) {
      return null; // File doesn't exist at this ref — not an error
    }
    throw error;
  }
}

/**
 * Gets the default branch of a repository.
 * Most repos use 'main', but some still use 'master' or custom names.
 * Never hardcode 'main' — always look it up.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string>}
 */
async function getDefaultBranch(octokit, owner, repo) {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

/**
 * Creates a new branch in the repository.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} branchName - Name for the new branch
 * @param {string} fromSha - The commit SHA to branch from
 * @returns {Promise<void>}
 */
async function createBranch(octokit, owner, repo, branchName, fromSha) {
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  });
}

/**
 * Commits a file to a branch.
 * If the file already exists on the branch, updates it.
 * If it doesn't exist, creates it.
 *
 * GitHub's Contents API requires the current file SHA when updating
 * (to prevent overwriting concurrent changes — optimistic locking).
 * When creating a new file, no SHA is needed.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath - Path within the repo
 * @param {string} content - File content (UTF-8 string)
 * @param {string} message - Commit message
 * @param {string} branch - Target branch
 * @returns {Promise<void>}
 */
async function commitFile(octokit, owner, repo, filePath, content, message, branch) {
  // Check if the file already exists (needed for the update SHA)
  let currentFileSha = undefined;
  try {
    const existing = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch,
    });
    if (existing.data.sha) {
      currentFileSha = existing.data.sha;
    }
  } catch (error) {
    if (error.status !== 404) throw error;
    // 404 means file doesn't exist yet — that's fine, we're creating it
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    // GitHub API requires base64-encoded content
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    // Include SHA only when updating an existing file
    ...(currentFileSha && { sha: currentFileSha }),
  });
}

/**
 * Opens a Pull Request.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {object} prData - PR title, body, head branch, base branch
 * @returns {Promise<PullRequest>} The created PR object
 */
async function createPullRequest(octokit, owner, repo, prData) {
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: prData.title,
    body: prData.body,
    head: prData.head,
    base: prData.base,
    // Draft PRs are marked as work-in-progress — appropriate for auto-generated docs
    // that need human review before merging
    draft: false,
  });
  return data;
}

/**
 * Posts a comment on a Pull Request.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {string} body - Markdown-formatted comment body
 * @returns {Promise<void>}
 */
async function postPRComment(octokit, owner, repo, pullNumber, body) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber, // GitHub's API uses issue_number for PR comments too
    body,
  });
}

/**
 * Gets the HEAD commit SHA of a branch.
 * Used to create a new branch from the current tip of main/master.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @returns {Promise<string>} Commit SHA
 */
async function getBranchSha(octokit, owner, repo, branch) {
  const { data } = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch,
  });
  return data.commit.sha;
}

module.exports = {
  getApp,
  getInstallationOctokit,
  getPRFiles,
  getFileContent,
  getDefaultBranch,
  createBranch,
  commitFile,
  createPullRequest,
  postPRComment,
  getBranchSha,
};
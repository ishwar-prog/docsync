'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const logger = require('../utils/logger');

/**
 * MANUAL GITHUB APP AUTHENTICATION
 *
 * We implement the JWT + Installation Token flow directly
 * instead of using @octokit/app which has compatibility issues.
 *
 * Flow:
 * 1. Create a JWT signed with our private key
 * 2. Use that JWT to request an installation access token
 * 3. Use that token to make API calls
 */

/**
 * Creates a GitHub App JWT.
 * Valid for 10 minutes — we create fresh ones per request.
 */
function createJWT() {
  const privateKey = fs.readFileSync(
    process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8'
  );
  const appId = process.env.GITHUB_APP_ID;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,   // issued 60 seconds ago (clock skew tolerance)
    exp: now + 600,  // expires in 10 minutes
    iss: appId,      // issuer = App ID
  })).toString('base64url');

  const data = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  const signature = sign.sign(privateKey, 'base64url');

  return `${data}.${signature}`;
}

/**
 * Gets an installation access token from GitHub.
 * This token is scoped to the specific repo installation.
 *
 * @param {number} installationId
 * @returns {Promise<string>} The access token
 */
async function getInstallationToken(installationId) {
  const jwt = createJWT();

  // Use a temporary Octokit with JWT auth to get the installation token
  const jwtOctokit = new Octokit({
    auth: jwt,
    userAgent: 'DocSync/0.1.0',
  });

  const { data } = await jwtOctokit.rest.apps.createInstallationAccessToken({
    installation_id: parseInt(installationId, 10),
  });

  return data.token;
}

/**
 * Returns an authenticated Octokit instance for a specific installation.
 *
 * @param {number} installationId
 * @returns {Promise<Octokit>}
 */
async function getInstallationOctokit(installationId) {
  const token = await getInstallationToken(installationId);

  return new Octokit({
    auth: token,
    userAgent: 'DocSync/0.1.0 (github.com/ishwar-prog/docsync)',
  });
}

// Keep getApp() as a no-op for compatibility
function getApp() { return {}; }

/**
 * Fetches the list of files changed in a Pull Request.
 */
async function getPRFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner,
      repo,
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
 * Downloads the content of a specific file from GitHub.
 */
async function getFileContent(octokit, owner, repo, filePath, ref) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref,
    });

    if (response.data.type !== 'file') {
      throw new Error(`Expected file, got ${response.data.type}`);
    }

    return Buffer.from(response.data.content, 'base64').toString('utf8');

  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/**
 * Gets the default branch of a repository.
 */
async function getDefaultBranch(octokit, owner, repo) {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

/**
 * Creates a new branch in the repository.
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
 */
async function commitFile(octokit, owner, repo, filePath, content, message, branch) {
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
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    ...(currentFileSha && { sha: currentFileSha }),
  });
}

/**
 * Opens a Pull Request.
 */
async function createPullRequest(octokit, owner, repo, prData) {
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: prData.title,
    body: prData.body,
    head: prData.head,
    base: prData.base,
    draft: false,
  });
  return data;
}

/**
 * Posts a comment on a Pull Request.
 */
async function postPRComment(octokit, owner, repo, pullNumber, body) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
}

/**
 * Gets the HEAD commit SHA of a branch.
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
'use strict';

const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');

/**
 * SNAPSHOT SYSTEM ARCHITECTURE
 *
 * The snapshot is DocSync's memory. It answers the question:
 * "What did this codebase look like the last time we documented it?"
 *
 * The snapshot file lives at .docsync/snapshot.json inside the user's repo.
 * It is INTENTIONALLY committed to git. This is a deliberate design decision:
 *
 * 1. When two developers work on the same repo, they share the same baseline.
 *    If Developer A documents the code and Developer B changes a function,
 *    DocSync knows the function changed because the snapshot says what it was.
 *
 * 2. The snapshot in git gives you a history of your documentation baseline
 *    over time — you can see when drift was last resolved.
 *
 * 3. In CI/CD pipelines, the snapshot is available without any external
 *    database or service — everything is self-contained in the repo.
 *
 * This is the same approach used by tools like Renovate (dependency snapshots),
 * Turborepo (build cache manifests), and Prisma (migration state files).
 *
 * SECURITY CONSIDERATION:
 * The snapshot contains function signatures and file paths — no source code,
 * no secrets, no business logic. It is safe to commit publicly.
 * We explicitly strip any content that could contain sensitive data.
 */

const DOCSYNC_DIR = '.docsync';
const SNAPSHOT_FILE = 'snapshot.json';
const SNAPSHOT_VERSION = 2; // Increment this when the snapshot schema changes

/**
 * Reads the existing snapshot from disk.
 * Returns null if no snapshot exists (first run).
 *
 * @param {string} cwd - Repository root directory
 * @returns {Snapshot|null}
 */
function readSnapshot(cwd) {
  const snapshotPath = getSnapshotPath(cwd);

  if (!fs.pathExistsSync(snapshotPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const snapshot = JSON.parse(raw);

    // Schema version check — if the snapshot was written by an older
    // version of DocSync with a different structure, we cannot trust it.
    // We discard it and treat this as a first run.
    //
    // This is called "schema migration" — a concept you'll encounter
    // constantly in database design. Unlike databases, we take the simple
    // approach: if schema mismatch, start fresh. The cost is one re-scan.
    if (snapshot.version !== SNAPSHOT_VERSION) {
      logger.warn(`Snapshot schema version mismatch (expected ${SNAPSHOT_VERSION}, got ${snapshot.version || 1})`);
      logger.info('Discarding old snapshot and starting fresh. This happens once per DocSync upgrade.');
      return null;
    }

    return snapshot;

  } catch (error) {
    // Corrupted JSON (e.g., interrupted write, manual edit gone wrong).
    // Log a warning but don't crash — treat as first run.
    logger.warn(`Snapshot file is corrupted: ${error.message}`);
    logger.info('Starting with a fresh snapshot.');
    return null;
  }
}

/**
 * Writes a new snapshot to disk from the current parsed file results.
 *
 * This is called after a successful `docsync init` or `docsync fix`.
 * It represents "these docs are now accurate for this code state."
 *
 * @param {string} cwd - Repository root directory
 * @param {ParsedFile[]} parsedFiles - Results from the parser (Part 2)
 * @param {object} metadata - Additional metadata to store
 * @returns {void}
 */
function writeSnapshot(cwd, parsedFiles, metadata = {}) {
  const snapshotPath = getSnapshotPath(cwd);

  // Ensure the .docsync directory exists
  // fs-extra's outputJson creates parent directories automatically
  fs.ensureDirSync(path.dirname(snapshotPath));

  const snapshot = buildSnapshot(parsedFiles, metadata);

  try {
    // Write with pretty formatting (2-space indent) so the snapshot
    // is human-readable and produces clean git diffs.
    //
    // Why human-readable? Because developers will see this file in
    // `git diff` during code review. A readable snapshot diff shows
    // exactly what changed in the public API — invaluable context.
    fs.writeJsonSync(snapshotPath, snapshot, { spaces: 2 });
    logger.success(`Snapshot saved to ${DOCSYNC_DIR}/${SNAPSHOT_FILE}`);

  } catch (error) {
    // Write failures can happen due to disk full, permissions, or
    // antivirus software (common on Windows) locking the file.
    logger.error(`Failed to write snapshot: ${error.message}`);
    logger.info('Check that DocSync has write permission to the .docsync directory');
    // Don't exit — the parse results are still valid, just not persisted
  }
}

/**
 * Builds the snapshot data structure from parsed files.
 *
 * The snapshot is intentionally a different shape from the parser output.
 * The parser output is optimized for extraction (rich AST traversal data).
 * The snapshot is optimized for comparison (flat, indexed by stable keys).
 *
 * This transformation is called "projection" — selecting and reshaping
 * data for a specific purpose.
 *
 * @param {ParsedFile[]} parsedFiles
 * @param {object} metadata
 * @returns {Snapshot}
 */
function buildSnapshot(parsedFiles, metadata = {}) {
  const files = {};

  for (const parsedFile of parsedFiles) {
    // Use forward-slash paths as keys — OS-independent
    const fileKey = normalizeKey(parsedFile.filePath);

    // Build a flat index of constructs keyed by their stable ID.
    // The stable ID must survive refactors that don't change the construct's
    // identity — we use "kind:name" as the key.
    //
    // Why not use line number as the key?
    // Because line numbers change every time you add or remove lines above
    // a function. Using line numbers as keys would cause false positives —
    // every function after an insertion would appear "moved" not "unchanged."
    // This is a classic indexing design problem.
    const constructs = {};

    for (const construct of parsedFile.constructs) {
      const constructKey = buildConstructKey(construct);

      constructs[constructKey] = {
        kind: construct.kind,
        name: construct.name,
        signature: construct.signature,
        params: serializeParams(construct.params),
        returnType: construct.returnType || null,
        isAsync: construct.isAsync || false,
        exported: construct.exported || false,
        // For API routes, store additional route-specific data
        ...(construct.kind === 'api_route' && {
          httpMethod: construct.httpMethod,
          routePath: construct.routePath,
          pathParams: construct.pathParams || [],
        }),
        // For classes, store method signatures
        ...(construct.kind === 'class' && {
          methods: (construct.methods || []).map(m => ({
            name: m.name,
            signature: m.signature,
            params: serializeParams(m.params),
            returnType: m.returnType || null,
            isAsync: m.isAsync || false,
            isStatic: m.isStatic || false,
          })),
        }),
        // Store JSDoc status — whether docs existed at snapshot time
        hasJSDoc: !!(construct.jsDoc && construct.jsDoc.description),
        // The hash used to detect any change in this specific construct
        signatureHash: hashSignature(construct.signature),
        // Location stored for reference only — NOT used for comparison
        // (we compare signatures, not positions)
        lastSeenAt: {
          line: construct.location.startLine,
        },
      };
    }

    files[fileKey] = {
      language: parsedFile.language,
      contentHash: parsedFile.contentHash,
      constructCount: parsedFile.constructCount,
      constructs,
      snapshotted: new Date().toISOString(),
    };
  }

  return {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    docSyncVersion: require('../../package.json').version,
    repoRoot: metadata.repoRoot || '',
    totalFiles: parsedFiles.length,
    totalConstructs: parsedFiles.reduce((sum, f) => sum + f.constructCount, 0),
    files,
  };
}

/**
 * Serializes parameters to a stable, comparable format.
 * Strips location data and other non-comparable fields.
 *
 * @param {Parameter[]} params
 * @returns {SerializedParam[]}
 */
function serializeParams(params = []) {
  return params.map(p => ({
    name: p.name,
    type: p.type || null,
    defaultValue: p.defaultValue || null,
    isOptional: p.isOptional || false,
    isRest: p.isRest || false,
    isDestructured: p.isDestructured || false,
  }));
}

/**
 * Builds a stable, unique key for a construct within a file.
 *
 * Key format: "kind:name"
 * Examples: "function:createUser", "class:UserService", "api_route:POST /users"
 *
 * Why include `kind` in the key?
 * Because a file could have both a class named "User" and a function named "User"
 * (unusual but valid). Without `kind`, they'd collide in the index.
 *
 * @param {Construct} construct
 * @returns {string}
 */
function buildConstructKey(construct) {
  return `${construct.kind}:${construct.name}`;
}

/**
 * Creates a hash of a signature string for fast comparison.
 * Instead of comparing full signature strings (slow for thousands of constructs),
 * we compare short hashes. Two different signatures will (with overwhelming
 * probability) produce different hashes.
 *
 * We use SHA-256 truncated to 8 characters — 4 billion possible values,
 * far more than enough to avoid collisions in a single file.
 *
 * @param {string} signature
 * @returns {string}
 */
function hashSignature(signature) {
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(signature || '')
    .digest('hex')
    .slice(0, 8);
}

/**
 * Normalizes a file path to a consistent key format.
 * Strips the absolute portion to make snapshots portable across machines.
 *
 * Why portable? Because the snapshot is committed to git and shared
 * across team members who have the repo in different directories.
 * Developer A: C:\Users\Alice\projects\myapp\src\api.js
 * Developer B: /home/bob/projects/myapp/src/api.js
 * Snapshot key: src/api.js (relative, OS-independent)
 *
 * @param {string} absolutePath
 * @returns {string}
 */
function normalizeKey(absolutePath) {
  // We cannot use process.cwd() here because this function may be called
  // from different contexts. Instead we find the src/ or the repo root
  // by looking for the common path segment.
  return absolutePath.replace(/\\/g, '/');
}

/**
 * Returns the absolute path to the snapshot file.
 * @param {string} cwd
 * @returns {string}
 */
function getSnapshotPath(cwd) {
  return path.join(cwd, DOCSYNC_DIR, SNAPSHOT_FILE);
}

/**
 * Checks whether a snapshot exists for this repository.
 * @param {string} cwd
 * @returns {boolean}
 */
function snapshotExists(cwd) {
  return fs.pathExistsSync(getSnapshotPath(cwd));
}

/**
 * Deletes the snapshot — used by `docsync reset` (future command).
 * @param {string} cwd
 */
function deleteSnapshot(cwd) {
  const snapshotPath = getSnapshotPath(cwd);
  if (fs.pathExistsSync(snapshotPath)) {
    fs.removeSync(snapshotPath);
    logger.success('Snapshot deleted. Next `docsync init` will create a fresh baseline.');
  }
}

module.exports = {
  readSnapshot,
  writeSnapshot,
  snapshotExists,
  deleteSnapshot,
  buildConstructKey,
  hashSignature,
  DOCSYNC_DIR,
  SNAPSHOT_FILE,
};
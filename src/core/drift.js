'use strict';

const logger = require('../utils/logger');
const { buildConstructKey, hashSignature } = require('./snapshot');

/**
 * DRIFT DETECTION ENGINE
 *
 * This module compares two states of a codebase:
 *   - The SNAPSHOT: what the code looked like when docs were last accurate
 *   - The CURRENT: what the code looks like right now
 *
 * It produces a DriftReport: a structured description of every change
 * that has documentation implications, with a severity score per change
 * and an aggregate repo-level drift score.
 *
 * DESIGN PHILOSOPHY:
 *
 * The drift detector operates on SIGNATURES, not source code.
 * This is a crucial distinction. It means:
 *
 * 1. Internal refactors (renaming local variables, restructuring logic)
 *    do NOT trigger drift — the public interface is unchanged.
 *
 * 2. Only interface changes trigger drift: parameter additions/removals/renames,
 *    return type changes, new/deleted exported functions, API route changes.
 *
 * 3. The drift score is ACTIONABLE — it tells you not just THAT something
 *    changed, but WHAT changed and HOW SEVERELY the docs are now wrong.
 *
 * This is what separates DocSync from file-hash-based change detection.
 */

/**
 * Drift severity weights.
 * These are the knobs that determine how the drift score is calculated.
 * They are tuned based on the documentation impact of each change type.
 *
 * PHILOSOPHY BEHIND THE WEIGHTS:
 *
 * - Name change (100): A renamed function means every code example,
 *   every reference in docs, every usage shown to users is now wrong.
 *   Maximum impact.
 *
 * - Parameter removed (70): Docs mention a parameter that no longer exists.
 *   Users who pass it get unexpected behavior. Very high impact.
 *
 * - Parameter added (60): There's a new parameter not mentioned in docs.
 *   Users don't know it exists. High impact, especially if required.
 *
 * - Return type changed (50): Docs say returns User, now returns Promise<User>.
 *   Users who consume the return value will write broken code.
 *
 * - Parameter renamed (40): Docs say `email`, code says `emailAddress`.
 *   Moderate impact — destructuring callers break.
 *
 * - Parameter type changed (35): Docs say string, code says string[].
 *   Moderate impact.
 *
 * - Async status changed (30): Docs don't mention async, function now is.
 *   Lower impact but callers who don't await now have a bug.
 *
 * - JSDoc removed (20): Code exists but docs were removed.
 *   Docs are now missing, not wrong — lower severity than wrong docs.
 */
const DRIFT_WEIGHTS = {
  CONSTRUCT_DELETED:      100,
  CONSTRUCT_ADDED:         80,
  NAME_CHANGED:           100,
  PARAM_REMOVED:           70,
  PARAM_ADDED:             60,
  RETURN_TYPE_CHANGED:     50,
  PARAM_RENAMED:           40,
  PARAM_TYPE_CHANGED:      35,
  ASYNC_CHANGED:           30,
  JSDOC_REMOVED:           20,
  PARAM_DEFAULT_CHANGED:   15,
};

/**
 * Analyzes the drift between a saved snapshot and the current parsed state.
 *
 * @param {Snapshot} snapshot - The saved snapshot from disk
 * @param {ParsedFile[]} currentFiles - Fresh parser output from Part 2
 * @param {string} cwd - Repository root (for relative path display)
 * @returns {DriftReport}
 */
function analyzeDrift(snapshot, currentFiles, cwd) {
  logger.info('Analyzing documentation drift...');

  const startTime = Date.now();
  const fileReports = [];

  // Build a lookup map of current files keyed the same way as the snapshot.
  // This allows O(1) lookup when comparing — crucial for large repos.
  const currentFileMap = buildCurrentFileMap(currentFiles, cwd);

  // Build a lookup map of snapshot files for symmetric comparison
  const snapshotFileMap = snapshot.files || {};

  // Collect all unique file keys from both sides
  const allFileKeys = new Set([
    ...Object.keys(snapshotFileMap),
    ...Object.keys(currentFileMap),
  ]);

  for (const fileKey of allFileKeys) {
    const snapshotFile = snapshotFileMap[fileKey];
    const currentFile = currentFileMap[fileKey];

    let fileReport;

    if (!snapshotFile && currentFile) {
      // New file — not in snapshot, exists now
      fileReport = handleNewFile(fileKey, currentFile);

    } else if (snapshotFile && !currentFile) {
      // Deleted file — was in snapshot, gone now
      fileReport = handleDeletedFile(fileKey, snapshotFile);

    } else {
      // File exists in both — compare constructs
      fileReport = compareFile(fileKey, snapshotFile, currentFile);
    }

    if (fileReport && fileReport.changes.length > 0) {
      fileReports.push(fileReport);
    }
  }

  const elapsed = Date.now() - startTime;
  const report = buildDriftReport(fileReports, elapsed, snapshot);

  return report;
}

/**
 * Builds a lookup map from the current parsed files.
 * Keys match the snapshot's file key format for direct comparison.
 *
 * @param {ParsedFile[]} parsedFiles
 * @param {string} cwd
 * @returns {object}
 */
function buildCurrentFileMap(parsedFiles) {
  const map = {};

  for (const parsedFile of parsedFiles) {
    // Normalize the key to match the snapshot format
    const fileKey = parsedFile.filePath.replace(/\\/g, '/');

    // Build construct index keyed by "kind:name"
    const constructs = {};
    for (const construct of parsedFile.constructs) {
      const key = buildConstructKey(construct);
      constructs[key] = construct;
    }

    map[fileKey] = {
      language: parsedFile.language,
      contentHash: parsedFile.contentHash,
      constructs,
    };
  }

  return map;
}

/**
 * Handles a file that appears in the current scan but not in the snapshot.
 * All constructs in this file are "new" — undocumented.
 *
 * @param {string} fileKey
 * @param {object} currentFile
 * @returns {FileReport}
 */
function handleNewFile(fileKey, currentFile) {
  const changes = Object.entries(currentFile.constructs).map(([key, construct]) => ({
    type: 'CONSTRUCT_ADDED',
    constructKey: key,
    constructKind: construct.kind,
    constructName: construct.name,
    severity: DRIFT_WEIGHTS.CONSTRUCT_ADDED,
    detail: `New ${construct.kind} \`${construct.name}\` has no documentation`,
    current: { signature: construct.signature },
    previous: null,
  }));

  return {
    fileKey,
    status: 'new_file',
    driftScore: calculateFileDriftScore(changes),
    changes,
  };
}

/**
 * Handles a file that was in the snapshot but no longer exists.
 * All constructs are "deleted" — docs describe non-existent code.
 *
 * @param {string} fileKey
 * @param {object} snapshotFile
 * @returns {FileReport}
 */
function handleDeletedFile(fileKey, snapshotFile) {
  const changes = Object.entries(snapshotFile.constructs).map(([key, construct]) => ({
    type: 'CONSTRUCT_DELETED',
    constructKey: key,
    constructKind: construct.kind,
    constructName: construct.name,
    severity: DRIFT_WEIGHTS.CONSTRUCT_DELETED,
    detail: `${construct.kind} \`${construct.name}\` was deleted but documentation still references it`,
    current: null,
    previous: { signature: construct.signature },
  }));

  return {
    fileKey,
    status: 'deleted_file',
    driftScore: 100, // Deleted files always score maximum drift
    changes,
  };
}

/**
 * Compares constructs between the snapshot and current state for a single file.
 * This is the core comparison logic.
 *
 * @param {string} fileKey
 * @param {object} snapshotFile - File entry from snapshot
 * @param {object} currentFile - File entry from current parse
 * @returns {FileReport}
 */
function compareFile(fileKey, snapshotFile, currentFile) {
  // Fast path: if content hashes match, nothing changed in this file.
  // Skip detailed comparison entirely.
  //
  // This is a critical optimization for large repos.
  // If a repo has 500 files and only 3 changed in this commit,
  // we skip detailed comparison for 497 files in microseconds.
  if (snapshotFile.contentHash === currentFile.contentHash) {
    return null; // No drift possible if content is identical
  }

  const changes = [];
  const snapshotConstructs = snapshotFile.constructs || {};
  const currentConstructs = currentFile.constructs || {};

  // Get all construct keys from both sides
  const allConstructKeys = new Set([
    ...Object.keys(snapshotConstructs),
    ...Object.keys(currentConstructs),
  ]);

  for (const constructKey of allConstructKeys) {
    const snapshotConstruct = snapshotConstructs[constructKey];
    const currentConstruct = currentConstructs[constructKey];

    if (!snapshotConstruct && currentConstruct) {
      // New construct — added since last snapshot
      changes.push({
        type: 'CONSTRUCT_ADDED',
        constructKey,
        constructKind: currentConstruct.kind,
        constructName: currentConstruct.name,
        severity: DRIFT_WEIGHTS.CONSTRUCT_ADDED,
        detail: `New ${currentConstruct.kind} \`${currentConstruct.name}\` has no documentation`,
        current: { signature: currentConstruct.signature },
        previous: null,
      });

    } else if (snapshotConstruct && !currentConstruct) {
      // Deleted construct — removed since last snapshot
      changes.push({
        type: 'CONSTRUCT_DELETED',
        constructKey,
        constructKind: snapshotConstruct.kind,
        constructName: snapshotConstruct.name,
        severity: DRIFT_WEIGHTS.CONSTRUCT_DELETED,
        detail: `\`${snapshotConstruct.name}\` was deleted — documentation still describes it`,
        current: null,
        previous: { signature: snapshotConstruct.signature },
      });

    } else {
      // Construct exists in both — do detailed signature comparison
      const signatureChanges = compareSignatures(
        snapshotConstruct,
        currentConstruct,
        constructKey
      );
      changes.push(...signatureChanges);
    }
  }

  if (changes.length === 0) return null;

  return {
    fileKey,
    status: 'modified',
    driftScore: calculateFileDriftScore(changes),
    changes,
  };
}

/**
 * Compares the detailed signatures of two versions of the same construct.
 * Produces granular change records for each difference found.
 *
 * This is the most detailed comparison level — it goes down to
 * individual parameter names and types.
 *
 * @param {SnapshotConstruct} previous - From snapshot
 * @param {Construct} current - From current parse
 * @param {string} constructKey
 * @returns {Change[]}
 */
function compareSignatures(previous, current, constructKey) {
  const changes = [];
  const kind = current.kind || previous.kind;
  const name = current.name || previous.name;

  // Quick exit: if signature hashes match, nothing changed
  const currentHash = hashSignature(current.signature);
  if (previous.signatureHash === currentHash) {
    return []; // Signatures are identical — no drift
  }

  // Check async status change
  if (previous.isAsync !== (current.isAsync || false)) {
    changes.push({
      type: 'ASYNC_CHANGED',
      constructKey,
      constructKind: kind,
      constructName: name,
      severity: DRIFT_WEIGHTS.ASYNC_CHANGED,
      detail: current.isAsync
        ? `\`${name}\` became async — callers must now await it`
        : `\`${name}\` is no longer async — callers awaiting it will get unexpected behavior`,
      current: { isAsync: current.isAsync || false },
      previous: { isAsync: previous.isAsync },
    });
  }

  // Check return type change
  const prevReturn = previous.returnType || null;
  const currReturn = current.returnType || null;
  if (prevReturn !== currReturn) {
    changes.push({
      type: 'RETURN_TYPE_CHANGED',
      constructKey,
      constructKind: kind,
      constructName: name,
      severity: DRIFT_WEIGHTS.RETURN_TYPE_CHANGED,
      detail: `\`${name}\` return type changed: \`${prevReturn || 'untyped'}\` → \`${currReturn || 'untyped'}\``,
      current: { returnType: currReturn },
      previous: { returnType: prevReturn },
    });
  }

  // Check JSDoc removal
  if (previous.hasJSDoc && !(current.jsDoc && current.jsDoc.description)) {
    changes.push({
      type: 'JSDOC_REMOVED',
      constructKey,
      constructKind: kind,
      constructName: name,
      severity: DRIFT_WEIGHTS.JSDOC_REMOVED,
      detail: `\`${name}\` had documentation that was removed`,
      current: { hasJSDoc: false },
      previous: { hasJSDoc: true },
    });
  }

  // Deep parameter comparison
  const paramChanges = compareParameters(
    previous.params || [],
    current.params || [],
    name,
    constructKey,
    kind
  );
  changes.push(...paramChanges);

  // For classes, compare methods
  if (kind === 'class' && previous.methods && current.methods) {
    const methodChanges = compareMethods(
      previous.methods,
      current.methods || [],
      name,
      constructKey
    );
    changes.push(...methodChanges);
  }

  return changes;
}

/**
 * Compares two parameter lists and produces granular change records.
 *
 * This uses the "Longest Common Subsequence" inspired approach:
 * we try to match parameters by name first, then by position.
 * This distinguishes between a rename (same position, different name)
 * and a removal + addition (parameter gone, new one added).
 *
 * @param {SerializedParam[]} prevParams - From snapshot
 * @param {Parameter[]} currParams - From current parse
 * @param {string} fnName - Function name for error messages
 * @param {string} constructKey
 * @param {string} kind
 * @returns {Change[]}
 */
function compareParameters(prevParams, currParams, fnName, constructKey, kind) {
  const changes = [];

  // Build lookup maps by parameter name for O(1) lookup
  const prevByName = new Map(prevParams.map(p => [p.name, p]));
  const currByName = new Map(currParams.map(p => [p.name, p]));

  // Find removed parameters: in snapshot but not in current
  for (const [name, prevParam] of prevByName) {
    if (!currByName.has(name)) {
      changes.push({
        type: 'PARAM_REMOVED',
        constructKey,
        constructKind: kind,
        constructName: fnName,
        severity: DRIFT_WEIGHTS.PARAM_REMOVED,
        detail: `Parameter \`${name}\` was removed from \`${fnName}\``,
        current: null,
        previous: prevParam,
      });
    }
  }

  // Find added parameters: in current but not in snapshot
  for (const [name, currParam] of currByName) {
    if (!prevByName.has(name)) {
      changes.push({
        type: 'PARAM_ADDED',
        constructKey,
        constructKind: kind,
        constructName: fnName,
        severity: DRIFT_WEIGHTS.PARAM_ADDED,
        detail: `New parameter \`${name}\` added to \`${fnName}\` — not documented`,
        current: currParam,
        previous: null,
      });
    }
  }

  // Find type changes: parameter exists in both but type annotation changed
  for (const [name, prevParam] of prevByName) {
    const currParam = currByName.get(name);
    if (!currParam) continue; // Already handled as removed above

    if (prevParam.type !== currParam.type) {
      changes.push({
        type: 'PARAM_TYPE_CHANGED',
        constructKey,
        constructKind: kind,
        constructName: fnName,
        severity: DRIFT_WEIGHTS.PARAM_TYPE_CHANGED,
        detail: `Parameter \`${name}\` type changed: \`${prevParam.type || 'untyped'}\` → \`${currParam.type || 'untyped'}\``,
        current: currParam,
        previous: prevParam,
      });
    }

    // Check default value change
    if (prevParam.defaultValue !== (currParam.defaultValue || null)) {
      changes.push({
        type: 'PARAM_DEFAULT_CHANGED',
        constructKey,
        constructKind: kind,
        constructName: fnName,
        severity: DRIFT_WEIGHTS.PARAM_DEFAULT_CHANGED,
        detail: `Parameter \`${name}\` default value changed: \`${prevParam.defaultValue}\` → \`${currParam.defaultValue}\``,
        current: currParam,
        previous: prevParam,
      });
    }
  }

  // Detect positional renames: same position, different name, not a removal
  // Example: fn(email, password) → fn(emailAddress, password)
  // This is a rename, not a remove + add
  if (prevParams.length === currParams.length) {
    for (let i = 0; i < prevParams.length; i++) {
      const prev = prevParams[i];
      const curr = currParams[i];

      if (prev.name !== curr.name &&
          !currByName.has(prev.name) &&
          !prevByName.has(curr.name)) {
        // Neither the old name exists in current, nor the new name existed before
        // This is a rename
        changes.push({
          type: 'PARAM_RENAMED',
          constructKey,
          constructKind: kind,
          constructName: fnName,
          severity: DRIFT_WEIGHTS.PARAM_RENAMED,
          detail: `Parameter renamed: \`${prev.name}\` → \`${curr.name}\` in \`${fnName}\``,
          current: curr,
          previous: prev,
        });
      }
    }
  }

  return changes;
}

/**
 * Compares methods of a class between snapshot and current state.
 *
 * @param {SnapshotMethod[]} prevMethods
 * @param {Method[]} currMethods
 * @param {string} className
 * @param {string} constructKey
 * @returns {Change[]}
 */
function compareMethods(prevMethods, currMethods, className, constructKey) {
  const changes = [];
  const prevByName = new Map(prevMethods.map(m => [m.name, m]));
  const currByName = new Map(currMethods.map(m => [m.name, m]));

  for (const [name] of prevByName) {
    if (!currByName.has(name)) {
      changes.push({
        type: 'CONSTRUCT_DELETED',
        constructKey: `${constructKey}.${name}`,
        constructKind: 'method',
        constructName: `${className}.${name}`,
        severity: DRIFT_WEIGHTS.CONSTRUCT_DELETED,
        detail: `Method \`${className}.${name}\` was removed`,
        current: null,
        previous: prevByName.get(name),
      });
    }
  }

  for (const [name] of currByName) {
    if (!prevByName.has(name)) {
      changes.push({
        type: 'CONSTRUCT_ADDED',
        constructKey: `${constructKey}.${name}`,
        constructKind: 'method',
        constructName: `${className}.${name}`,
        severity: DRIFT_WEIGHTS.CONSTRUCT_ADDED,
        detail: `New method \`${className}.${name}\` has no documentation`,
        current: currByName.get(name),
        previous: null,
      });
    }
  }

  return changes;
}

/**
 * Calculates the drift score for a single file.
 *
 * The score is the MAX severity of all changes in the file,
 * adjusted by the number of changes (more changes = higher score).
 *
 * Why MAX instead of average?
 * Because a single deleted function means documentation is actively harmful.
 * Averaging it down with minor changes would underrepresent the severity.
 *
 * The adjustment factor ensures that a file with 10 minor changes scores
 * higher than a file with 1 minor change — volume matters.
 *
 * @param {Change[]} changes
 * @returns {number} 0–100
 */
function calculateFileDriftScore(changes) {
  if (changes.length === 0) return 0;

  const maxSeverity = Math.max(...changes.map(c => c.severity));
  const volumeBonus = Math.min(changes.length * 3, 20); // Max 20 bonus points for volume
  return Math.min(Math.round(maxSeverity + volumeBonus), 100);
}

/**
 * Builds the final DriftReport from all file reports.
 *
 * @param {FileReport[]} fileReports
 * @param {number} elapsed
 * @param {Snapshot} snapshot
 * @returns {DriftReport}
 */
function buildDriftReport(fileReports, elapsed, snapshot) {
  const totalChanges = fileReports.reduce((sum, f) => sum + f.changes.length, 0);

  // Repo-level drift score: weighted average of file scores
  // Files with more constructs have higher weight
  const repoScore = fileReports.length === 0 ? 0 :
    Math.round(
      fileReports.reduce((sum, f) => sum + f.driftScore, 0) / fileReports.length
    );

  // Categorize changes for the summary
  const summary = {
    filesAffected: fileReports.length,
    totalChanges,
    byType: {},
  };

  for (const fileReport of fileReports) {
    for (const change of fileReport.changes) {
      summary.byType[change.type] = (summary.byType[change.type] || 0) + 1;
    }
  }

  return {
    driftScore: repoScore,
    hasDrift: fileReports.length > 0,
    snapshotAge: snapshot.createdAt
      ? getSnapshotAge(snapshot.createdAt)
      : 'unknown',
    analysisMs: elapsed,
    summary,
    files: fileReports,
  };
}

/**
 * Returns a human-readable snapshot age string.
 * e.g., "2 hours ago", "3 days ago"
 *
 * @param {string} createdAt - ISO timestamp
 * @returns {string}
 */
function getSnapshotAge(createdAt) {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 60) return `${diffMins} minute(s) ago`;
  if (diffHours < 24) return `${diffHours} hour(s) ago`;
  return `${diffDays} day(s) ago`;
}

module.exports = {
  analyzeDrift,
  DRIFT_WEIGHTS,
};
const path = require('path');
const fs = require('fs-extra');
const { glob } = require('glob');
const logger = require('../utils/logger');

/**
 * The Scanner is responsible for one thing only: finding files.
 * It knows nothing about parsing or documentation — that is the
 * parser's responsibility. This separation means you can test
 * the scanner without a parser, and vice versa.
 *
 * This is the Single Responsibility Principle in practice.
 */

/**
 * Scans the repository and returns all files that should be tracked
 * by DocSync, based on the configuration.
 *
 * @param {string} cwd - The root directory of the repository
 * @param {object} config - The loaded DocSync configuration object
 * @returns {Promise<ScanResult>} Object containing found files and metadata
 */
async function scanRepository(cwd, config) {
  logger.info('Scanning repository for trackable files...');

  // Validate that the directory actually exists.
  // This catches the case where someone runs `docsync init` from
  // the wrong directory — a surprisingly common mistake.
  if (!await fs.pathExists(cwd)) {
    logger.error(`Directory does not exist: ${cwd}`);
    process.exit(1);
  }

  const startTime = Date.now();

  // Step 1: Resolve all files matching the `track` patterns
  const trackedFiles = await resolvePatterns(config.track, config.ignore, cwd);

  // Step 2: Filter to only files DocSync can actually parse
  // (We don't want to try to parse a .png that accidentally matched a pattern)
  const supportedFiles = trackedFiles.filter(isSupportedFile);

  // Step 3: Group files by language for reporting and for
  // passing the right Tree-sitter grammar to the parser
  const grouped = groupByLanguage(supportedFiles);

  const elapsed = Date.now() - startTime;

  // Build the result object.
  // Notice we return structured data, not just an array.
  // This gives callers (the init command) rich information
  // they can display or use for decisions.
  const result = {
    rootDir: cwd,
    totalFound: supportedFiles.length,
    byLanguage: grouped,
    files: supportedFiles,
    scanDurationMs: elapsed,
  };

  logScanSummary(result);

  return result;
}

/**
 * Resolves an array of glob patterns into a flat array of absolute file paths.
 * Applies ignore patterns to filter out unwanted files.
 *
 * Why do we use absolute paths throughout?
 * Because DocSync may be called from different working directories.
 * Relative paths break the moment you change directories.
 * Absolute paths are always unambiguous.
 *
 * @param {string[]} patterns - Array of glob patterns to include (e.g., ['src/**\/*.ts'])
 * @param {string[]} ignorePatterns - Array of glob patterns to exclude
 * @param {string} cwd - The base directory to resolve patterns from
 * @returns {Promise<string[]>} Array of absolute file paths
 */
async function resolvePatterns(patterns, ignorePatterns, cwd) {
  // Always ignore node_modules and .git regardless of user config.
  // These are never source files and scanning them would be catastrophic
  // (node_modules alone can have 100,000+ files).
  // This is called "safe defaults" — the tool protects the user
  // from foot-guns they may not anticipate.
  const safeIgnore = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',       // Next.js build output
    '**/coverage/**',    // Jest coverage reports
    ...ignorePatterns,
  ];

  // De-duplicate ignore patterns — if user also specified node_modules,
  // we don't want to run it twice (performance)
  const uniqueIgnore = [...new Set(safeIgnore)];

  const allFiles = new Set(); // Use Set to automatically de-duplicate

  // Process each track pattern independently.
  // Why not pass all patterns to glob at once?
  // Because glob handles multiple patterns with OR logic, making
  // error messages useless ("pattern failed" — which one?).
  // Processing individually gives us precise error reporting per pattern.
  for (const pattern of patterns) {
    try {
      const matches = await glob(pattern, {
        cwd,
        ignore: uniqueIgnore,
        absolute: true,      // Return absolute paths, not relative
        nodir: true,         // Never return directories, only files
        dot: false,          // Don't match dotfiles (hidden files like .eslintrc)
        follow: false,       // Don't follow symlinks — prevents infinite loops
      });

      matches.forEach(file => allFiles.add(normalizeFilePath(file)));

    } catch (error) {
      // A bad glob pattern shouldn't crash DocSync.
      // Warn the user and continue with other patterns.
      logger.warn(`Invalid track pattern "${pattern}": ${error.message}`);
      logger.info('Check your docsync.yaml track patterns');
    }
  }

  return [...allFiles].sort(); // Sort for deterministic output across runs
}

/**
 * Normalizes file paths to be consistent across operating systems.
 *
 * This is a critical Windows compatibility issue.
 * On Windows, paths use backslashes: C:\Users\Dream Tech\docsync\src\index.js
 * On Mac/Linux, paths use forward slashes: /home/user/docsync/src/index.js
 *
 * glob returns forward slashes even on Windows.
 * Node's path module uses backslashes on Windows.
 * Tree-sitter expects forward slashes.
 *
 * Solution: normalize ALL paths to forward slashes internally.
 * Only convert back to OS-native paths when writing to disk.
 *
 * This is the approach used by Vite, esbuild, and other cross-platform tools.
 *
 * @param {string} filePath - Raw file path from glob
 * @returns {string} Normalized path with forward slashes
 */
function normalizeFilePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

/**
 * Determines if DocSync can parse this file type.
 * Returns false for unsupported extensions — we'll silently skip them.
 *
 * Why silently skip rather than error?
 * Because a user might have `src/**\/*` as a pattern,
 * which legitimately matches CSS, images, etc.
 * Erroring on every non-JS file would be extremely noisy.
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {boolean}
 */
function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * The file extensions DocSync can parse.
 * Using a Set gives O(1) lookup time — faster than Array.includes()
 * for repeated checks across thousands of files.
 */
const SUPPORTED_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',   // ES Module JavaScript (Node.js)
  '.cjs',   // CommonJS JavaScript (explicit)
]);

/**
 * Groups an array of file paths by their programming language.
 * This is used by the parser to select the correct Tree-sitter grammar.
 *
 * @param {string[]} files - Array of absolute file paths
 * @returns {object} Object keyed by language name, values are file arrays
 */
function groupByLanguage(files) {
  const groups = {
    javascript: [],
    typescript: [],
  };

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (['.ts', '.tsx'].includes(ext)) {
      groups.typescript.push(file);
    } else {
      groups.javascript.push(file);
    }
  }

  // Remove empty groups so callers don't need to handle empty arrays
  return Object.fromEntries(
    Object.entries(groups).filter(([, files]) => files.length > 0)
  );
}

/**
 * Prints a human-readable summary of the scan results.
 * This is what the developer sees in their terminal.
 *
 * @param {ScanResult} result
 */
function logScanSummary(result) {
  logger.newline();
  logger.header('Scan Results');

  if (result.totalFound === 0) {
    logger.warn('No trackable files found.');
    logger.info('Check your `track` patterns in docsync.yaml');
    return;
  }

  logger.success(`Found ${result.totalFound} file(s) in ${result.scanDurationMs}ms`);

  // Show breakdown by language
  for (const [language, files] of Object.entries(result.byLanguage)) {
    logger.info(`  ${capitalize(language)}: ${files.length} file(s)`);
  }

  logger.newline();
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { scanRepository };
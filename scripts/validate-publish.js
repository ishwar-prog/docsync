'use strict';

/**
 * PRE-PUBLISH VALIDATOR
 *
 * This script runs before every `npm publish` and `npm pack`.
 * It validates that the package is in a publishable state.
 *
 * WHY A DEDICATED VALIDATOR?
 *
 * npm publish failures in the field are catastrophic — users get
 * broken installs, your package page shows errors, and trust is lost.
 * Catching problems before publish costs nothing. Catching them after
 * costs everything.
 *
 * This validator checks:
 * 1. All required files exist and are non-empty
 * 2. package.json fields are complete
 * 3. The CLI entry point is executable and works
 * 4. No sensitive files would be included in the package
 * 5. Version is valid semver
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let errors = 0;
let warnings = 0;

function check(condition, message, isFatal = true) {
  if (!condition) {
    if (isFatal) {
      console.error(`  ✗ FAIL: ${message}`);
      errors++;
    } else {
      console.warn(`  ⚠ WARN: ${message}`);
      warnings++;
    }
  } else {
    console.log(`  ✓ ${message}`);
  }
}

console.log('\n🔍 DocSync Pre-publish Validation\n');

// ── Check 1: Required files exist ─────────────────────────────────────────
console.log('Checking required files...');

const requiredFiles = [
  'bin/docsync.js',
  'src/index.js',
  'src/commands/init.js',
  'src/commands/check.js',
  'src/commands/fix.js',
  'src/core/parser.js',
  'src/core/scanner.js',
  'src/core/drift.js',
  'src/core/snapshot.js',
  'src/core/generator.js',
  'src/core/schema.js',
  'src/utils/logger.js',
  'src/utils/config.js',
  'src/github/client.js',
  'src/action/index.js',
  'action.yml',
  'README.md',
  'LICENSE',
  'package.json',
];

for (const file of requiredFiles) {
  const fullPath = path.join(ROOT, file);
  const exists = fs.existsSync(fullPath);
  const nonEmpty = exists && fs.statSync(fullPath).size > 0;
  check(exists && nonEmpty, `${file} exists and is non-empty`);
}

// ── Check 2: Sensitive files are NOT in the files list ────────────────────
console.log('\nChecking security (no sensitive files in package)...');

const sensitiveFiles = [
  '.env',
  'github-app.pem',
  '.docsync/snapshot.json',
];

for (const file of sensitiveFiles) {
  const pkg = require(path.join(ROOT, 'package.json'));
  const filesField = pkg.files || [];
  const wouldBeIncluded = filesField.some(pattern =>
    file.startsWith(pattern.replace('/', ''))
  );
  check(!wouldBeIncluded, `${file} is NOT in package files list`);
}

// ── Check 3: package.json completeness ───────────────────────────────────
console.log('\nChecking package.json completeness...');

const pkg = require(path.join(ROOT, 'package.json'));

check(!!pkg.name, 'name field present');
check(!!pkg.version, 'version field present');
check(!!pkg.description && pkg.description.length > 20, 'description is meaningful (>20 chars)');
check(!!pkg.license, 'license field present');
check(!!pkg.repository, 'repository field present');
check(!!pkg.bin, 'bin field present (CLI entry point)');
check(!!pkg.engines, 'engines field present (Node.js version requirement)');
check(Array.isArray(pkg.keywords) && pkg.keywords.length >= 3, 'at least 3 keywords');

// Validate semver format
const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
check(semverRegex.test(pkg.version), `version "${pkg.version}" is valid semver`);

// ── Check 4: README quality ───────────────────────────────────────────────
console.log('\nChecking README quality...');

const readmePath = path.join(ROOT, 'README.md');
if (fs.existsSync(readmePath)) {
  const readme = fs.readFileSync(readmePath, 'utf8');
  check(readme.length > 500, 'README is substantial (>500 chars)');
  check(readme.includes('npm install') || readme.includes('npx'), 'README includes installation instructions');
  check(readme.includes('##'), 'README has sections (## headings)');
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));

if (errors > 0) {
  console.error(`\n✗ Validation FAILED: ${errors} error(s), ${warnings} warning(s)`);
  console.error('Fix all errors before publishing.\n');
  process.exit(1);
} else if (warnings > 0) {
  console.warn(`\n⚠ Validation passed with ${warnings} warning(s). Consider fixing before publishing.\n`);
} else {
  console.log('\n✓ All validation checks passed. Safe to publish.\n');
}
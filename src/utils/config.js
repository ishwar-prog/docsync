const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const logger = require('./logger');

// The default configuration.
// Every option has a sensible default so docsync works out-of-the-box
// with zero configuration.
//
// This is called the "convention over configuration" principle —
// made famous by Ruby on Rails. You only need to specify what's
// different from the defaults.

const DEFAULT_CONFIG = {
  version: 1,
  track: [
    'src/**/*.js',
    'src/**/*.ts',
    'src/**/*.jsx',
    'src/**/*.tsx',
  ],
  ignore: [
    '**/*.test.js',
    '**/*.test.ts',
    '**/*.spec.js',
    '**/*.spec.ts',
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
  ],
  output: {
    format: 'markdown',  // 'markdown' | 'mdx'
    dir: 'docs/',
  },
  style: {
    tone: 'technical',           // 'technical' | 'friendly' | 'concise'
    include_examples: true,
    heading_style: 'google',     // follows Google's developer documentation style guide
  },
  drift: {
    threshold: 75,    // 0–100. Higher = stricter. Drift above this triggers auto-PR
    auto_pr: true,
  }
};

/**
 * Reads docsync.yaml from the current working directory.
 * Merges it with defaults — user config overrides defaults,
 * but unspecified fields fall back to defaults.
 *
 * @param {string} cwd - The directory to look for docsync.yaml in
 * @returns {object} The merged configuration object
 */
function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, 'docsync.yaml');

  // If no config file exists, that's fine — use all defaults.
  // This is important: the tool should work without any configuration.
  if (!fs.pathExistsSync(configPath)) {
    logger.warn('No docsync.yaml found. Using default configuration.');
    logger.info('Run `docsync init` to create a config file.');
    return DEFAULT_CONFIG;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const userConfig = yaml.load(raw);

    // Deep merge: user config wins at every level,
    // but missing keys fall back to defaults.
    // We use a simple recursive merge here.
    const merged = deepMerge(DEFAULT_CONFIG, userConfig);

    logger.info(`Config loaded from ${chalk.cyan('docsync.yaml')}`);
    return merged;

  } catch (error) {
    // YAML parse errors give unhelpful messages by default.
    // We catch them and give a human-friendly error.
    logger.error(`Failed to parse docsync.yaml: ${error.message}`);
    logger.info('Check your YAML syntax at: https://yamlchecker.com');
    process.exit(1);  // Exit with error code 1 — signals failure to shell scripts
  }
}

/**
 * Recursively merges two objects.
 * Values from `override` take precedence over `base`.
 * Arrays are replaced (not concatenated) — this is intentional:
 * if the user specifies `track`, they want THEIR list, not theirs + defaults.
 */
function deepMerge(base, override) {
  const result = { ...base };

  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }

  return result;
}

/**
 * Writes a default docsync.yaml to the current directory.
 * Called by `docsync init`.
 */
function writeDefaultConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, 'docsync.yaml');

  if (fs.pathExistsSync(configPath)) {
    logger.warn('docsync.yaml already exists. Not overwriting.');
    return;
  }

  const defaultYaml = `# DocSync Configuration
# Full reference: https://docsync.dev/docs/config

version: 1

# Which files to track for documentation
track:
  - src/**/*.ts
  - src/**/*.js

# Files to ignore
ignore:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "**/node_modules/**"

# Output settings
output:
  format: markdown      # markdown | mdx
  dir: docs/

# Documentation style
style:
  tone: technical
  include_examples: true
  heading_style: google

# Drift detection settings
drift:
  threshold: 75         # 0-100. Drift above this threshold triggers a doc update
  auto_pr: true         # Automatically open a PR with updated docs
`;

  fs.outputFileSync(configPath, defaultYaml);
  logger.success(`Created ${chalk.cyan('docsync.yaml')}`);
}

module.exports = { loadConfig, writeDefaultConfig, DEFAULT_CONFIG };
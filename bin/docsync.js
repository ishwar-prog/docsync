#!/usr/bin/env node

// This first line is called a "shebang" (or hashbang).
// On Unix/Linux/macOS, when you run an executable file,
// the OS reads the first line to know which interpreter to use.
// "/usr/bin/env node" means: find `node` in the system PATH
// and use it to run this file.
//
// Without this line, running `docsync` in the terminal would
// cause the OS to try to execute the file as a shell script,
// which would fail with a confusing error.
//
// Windows ignores this line entirely — npm handles it differently
// on Windows by creating a .cmd wrapper file.

require('dotenv').config();  // Load .env before anything else

const { Command } = require('commander');
const { version } = require('../package.json');

const program = new Command();

program
  .name('docsync')
  .description('Auto-updating documentation that stays true to your code')
  .version(version, '-v, --version', 'Output the current version');

// Register subcommands
// Each command is defined in its own file — the entry point stays thin
program
  .command('init')
  .description('Scan repo and generate baseline documentation')
  .option('--config <path>', 'Path to config file', 'docsync.yaml')
  .option('--dry-run', 'Show what would be generated without writing files')
  .action((options) => {
    require('../src/commands/init')(options);
  });

program
  .command('check')
  .description('Check for documentation drift without making changes')
  .option('--json', 'Output drift report as JSON (useful for CI integration)')
  .action((options) => {
    require('../src/commands/check')(options);
  });

// Handle unknown commands gracefully
program.on('command:*', ([unknownCommand]) => {
  const logger = require('../src/utils/logger');
  logger.error(`Unknown command: ${unknownCommand}`);
  logger.info('Run `docsync --help` to see available commands');
  process.exit(1);
});

// Parse the actual terminal arguments
// process.argv is an array: ['node', '/path/to/docsync.js', 'init', '--dry-run']
// Commander reads from index 2 onwards (skipping 'node' and the script path)
program.parse(process.argv);

// If someone runs `docsync` with no arguments, show help
if (process.argv.length < 3) {
  program.help();
}
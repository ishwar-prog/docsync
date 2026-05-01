const chalk = require('chalk');

// Why build a custom logger instead of using console.log?
//
// 1. Consistency: Every log message has the same format and color scheme
// 2. Control: You can add a --silent flag later and disable all output in one place
// 3. Levels: info/warn/error/success have visual distinction
// 4. Future-proofing: If you ever write to a log file, you change this one file

const logger = {
  info: (message) => {
    console.log(chalk.blue('ℹ') + '  ' + message);
  },

  success: (message) => {
    console.log(chalk.green('✓') + '  ' + message);
  },

  warn: (message) => {
    console.log(chalk.yellow('⚠') + '  ' + message);
  },

  error: (message) => {
    console.error(chalk.red('✗') + '  ' + message);
  },

  // For grouped output with a header — used in drift reports
  header: (message) => {
    console.log('\n' + chalk.bold.white(message));
    console.log(chalk.gray('─'.repeat(message.length)));
  },

  // Blank line for visual spacing
  newline: () => {
    console.log('');
  }
};

function testWebhookFunction(userId, eventType) {
  console.log(userId, eventType);
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1000);
  const ms = milliseconds % 1000;
  return `${seconds}.${ms.toString().padStart(3, '0')}s`;
}

module.exports = logger;
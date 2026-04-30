'use strict';

require('dotenv').config();

const { startWebhookServer } = require('./github/webhook-server');
const logger = require('./utils/logger');

const rawPort = process.env.WEBHOOK_PORT || '3000';
const port = Number(rawPort);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  logger.error(`Invalid WEBHOOK_PORT: "${rawPort}". Must be an integer between 1 and 65535.`);
  process.exit(1);
}

logger.info(`Starting DocSync webhook server (Node.js ${process.version})`);
startWebhookServer(port);
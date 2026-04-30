'use strict';

require('dotenv').config();

const { startWebhookServer } = require('./github/webhook-server');
const logger = require('./utils/logger');

const port = parseInt(process.env.WEBHOOK_PORT || '3000', 10);

logger.info(`Starting DocSync webhook server (Node.js ${process.version})`);

startWebhookServer(port);
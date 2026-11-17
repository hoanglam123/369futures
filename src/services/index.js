'use strict';

const telegramCommands = require('./telegramCommands');

module.exports = {
  startTelegramCommands: telegramCommands.startTelegramCommands,
  stopTelegramCommands: telegramCommands.stopTelegramCommands,
  executeCommand: telegramCommands.executeCommand,
  setTradeProviders: telegramCommands.setTradeProviders,
  telegramCommands,
};

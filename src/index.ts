import makeDir from 'make-dir';
import path from 'path';
import container from './inversify.config.js';
import {TYPES} from './types.js';
import Bot from './bot.js';
import Config from './services/config.js';
import FileCacheProvider from './services/file-cache.js';
import VoiceCommandBridge from './services/voice-command-bridge.js';
import VoiceCommandService from './services/voice-command-service.js';
import PlayerManager from './managers/player.js';
import {Client} from 'discord.js';

const bot = container.get<Bot>(TYPES.Bot);
let shuttingDown = false;

const logShutdown = (message: string): void => {
  process.stderr.write(`[shutdown] ${message}\n`);
};

const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  logShutdown(`process received ${signal}`);
  logShutdown('disconnecting active voice sessions');
  container.get<PlayerManager>(TYPES.Managers.Player).disconnectAllForShutdown();

  logShutdown('stopping voice command bridge');
  container.get<VoiceCommandBridge>(TYPES.Services.VoiceCommandBridge).stop();

  logShutdown('destroying discord client');
  container.get<Client>(TYPES.Client).destroy();
};

const registerShutdownHandler = (signal: NodeJS.Signals) => {
  process.once(signal, () => {
    try {
      shutdown(signal);
      logShutdown('exiting process');
      process.exit();
    } catch (error) {
      logShutdown(`shutdown failed after ${signal}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exit(1);
    }
  });
};

const startBot = async () => {
  const config = container.get<Config>(TYPES.Config);

  await makeDir(config.DATA_DIR);
  await makeDir(config.CACHE_DIR);
  await makeDir(path.join(config.CACHE_DIR, 'tmp'));

  await container.get<FileCacheProvider>(TYPES.FileCache).cleanup();
  const voiceCommandBridge = container.get<VoiceCommandBridge>(TYPES.Services.VoiceCommandBridge);
  voiceCommandBridge.setVoiceCommandService(container.get<VoiceCommandService>(TYPES.Services.VoiceCommandService));
  voiceCommandBridge.start();

  registerShutdownHandler('SIGINT');
  registerShutdownHandler('SIGTERM');

  await bot.register();
};

export {startBot};

import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import Player from '../services/player.js';
import FileCacheProvider from '../services/file-cache.js';
import VoiceCommandBridge from '../services/voice-command-bridge.js';

@injectable()
export default class {
  private readonly guildPlayers: Map<string, Player>;
  private readonly fileCache: FileCacheProvider;
  private readonly voiceCommandBridge: VoiceCommandBridge;

  constructor(@inject(TYPES.FileCache) fileCache: FileCacheProvider,
    @inject(TYPES.Services.VoiceCommandBridge) voiceCommandBridge: VoiceCommandBridge) {
    this.guildPlayers = new Map();
    this.fileCache = fileCache;
    this.voiceCommandBridge = voiceCommandBridge;
  }

  get(guildId: string): Player {
    let player = this.guildPlayers.get(guildId);

    if (!player) {
      player = new Player(this.fileCache, guildId, this.voiceCommandBridge);

      this.guildPlayers.set(guildId, player);
    }

    return player;
  }

  disconnectAll(): void {
    for (const player of this.guildPlayers.values()) {
      player.disconnect();
    }
  }

  disconnectAllForShutdown(): void {
    for (const player of this.guildPlayers.values()) {
      player.disconnectForShutdown();
    }
  }
}

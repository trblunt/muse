import {VoiceChannel, VoiceState} from 'discord.js';
import {VoiceConnectionStatus} from '@discordjs/voice';
import container from '../inversify.config.js';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import {getSizeWithoutBots} from '../utils/channels.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';

export default async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
  const playerManager = container.get<PlayerManager>(TYPES.Managers.Player);

  const player = playerManager.get(oldState.guild.id);

  const logVoice = (message: string) => {
    if (process.env.VOICE_COMMANDS_DEBUG !== 'true') {
      return;
    }

    console.info(`[voice-debug] ${message}`);
  };

  if (player.voiceConnection) {
    const voiceChannel: VoiceChannel = oldState.guild.channels.cache.get(player.voiceConnection.joinConfig.channelId!) as VoiceChannel;
    const settings = await getGuildSettings(player.guildId);

    const {leaveIfNoListeners, voiceCommandsEnabled} = settings;
    const listenerCount = voiceChannel ? getSizeWithoutBots(voiceChannel) : 0;
    const shouldKeepAliveForVoiceCommands = player.shouldStayConnectedForVoiceCommands(voiceCommandsEnabled);
    logVoice(
      `voiceStateUpdate guild=${player.guildId} oldChannel=${oldState.channelId ?? 'none'} ` +
      `playerChannel=${voiceChannel?.id ?? 'none'} listeners=${listenerCount.toString()} ` +
      `leaveIfNoListeners=${leaveIfNoListeners.toString()} voiceCommandsEnabled=${voiceCommandsEnabled.toString()} ` +
      `keepAliveForVoiceCommands=${shouldKeepAliveForVoiceCommands.toString()} grace=${player.isInConnectGracePeriod().toString()}`,
    );

    if (player.isInConnectGracePeriod()) {
      logVoice(`skipping auto-disconnect during connect grace period for guild=${player.guildId}`);
      return;
    }

    if (!voiceChannel || (listenerCount === 0 && leaveIfNoListeners && !shouldKeepAliveForVoiceCommands)) {
      logVoice(`auto-disconnecting due to voiceStateUpdate for guild=${player.guildId}`);
      player.disconnect();
    }
  }
};

import {ChatInputCommandInteraction, GuildMember, MessageFlags} from 'discord.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import {TYPES} from '../types.js';
import {inject, injectable} from 'inversify';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {getMemberVoiceChannel} from '../utils/channels.js';
import {STATUS} from '../services/player.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('join')
    .setDescription('have Muse join your current voice channel');

  public requiresVC = true;

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const player = this.playerManager.get(interaction.guild!.id);
    const [targetVoiceChannel] = getMemberVoiceChannel(interaction.member as GuildMember) ?? [];

    if (!targetVoiceChannel) {
      throw new Error('gotta be in a voice channel');
    }

    const currentVoiceChannel = player.getCurrentVoiceChannel();
    if (currentVoiceChannel?.id === targetVoiceChannel.id) {
      await interaction.editReply('u betcha, already listening in your channel');
      return;
    }

    if (player.voiceConnection && player.status === STATUS.PLAYING) {
      throw new Error('already playing in another voice channel, use /disconnect first');
    }

    if (player.voiceConnection) {
      player.disconnect();
    }

    await player.connect(targetVoiceChannel);

    await interaction.editReply(`u betcha, now listening in **${targetVoiceChannel.name}**`);
  }
}

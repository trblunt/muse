import {SlashCommandBuilder} from '@discordjs/builders';
import {ChatInputCommandInteraction, PermissionFlagsBits} from 'discord.js';
import {inject, injectable} from 'inversify';
import Command from './index.js';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import Config from '../services/config.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {prisma} from '../utils/db.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('voice-commands')
    .setDescription('show or change wake-word voice command state for this guild')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addBooleanOption(option => option
      .setName('enabled')
      .setDescription('whether wake-word voice commands should stay enabled'));

  constructor(
    @inject(TYPES.Managers.Player) private readonly playerManager: PlayerManager,
    @inject(TYPES.Config) private readonly config: Config,
  ) {}

  public async execute(interaction: ChatInputCommandInteraction) {
    const settings = await getGuildSettings(interaction.guild!.id);
    const enabled = interaction.options.getBoolean('enabled');

    if (enabled === null) {
      const globalState = this.config.VOICE_COMMANDS_ENABLED ? 'on' : 'off';
      await interaction.reply(
        `voice commands are currently ${settings.voiceCommandsEnabled ? 'enabled' : 'disabled'} for this guild. ` +
        `Global voice commands are ${globalState}.`,
      );
      return;
    }

    await prisma.setting.update({
      where: {
        guildId: interaction.guild!.id,
      },
      data: {
        voiceCommandsEnabled: enabled,
      },
    });

    this.playerManager.get(interaction.guild!.id).refreshVoiceCommandListening(enabled);

    const suffix = this.config.VOICE_COMMANDS_ENABLED
      ? ''
      : ' Global VOICE_COMMANDS_ENABLED is off, so this will only apply after that is enabled.';
    await interaction.reply(`voice commands ${enabled ? 'enabled' : 'disabled'} for this guild.${suffix}`);
  }
}

import {AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction} from 'discord.js';

export interface SerializableSlashCommand {
  readonly name?: string;
  toJSON: () => unknown;
}

export default interface Command {
  readonly slashCommand: SerializableSlashCommand;
  readonly handledButtonIds?: readonly string[];
  readonly requiresVC?: boolean | ((interaction: ChatInputCommandInteraction) => boolean);
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleButtonInteraction?: (interaction: ButtonInteraction) => Promise<void>;
  handleAutocompleteInteraction?: (interaction: AutocompleteInteraction) => Promise<void>;
}

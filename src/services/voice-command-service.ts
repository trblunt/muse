import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import AddQueryToQueue from './add-query-to-queue.js';
import debug from '../utils/debug.js';
import {STATUS} from './player.js';
import Config from './config.js';
import errorMsg from '../utils/error-msg.js';

type ParsedVoiceCommand =
  | {intent: 'play'; query: string}
  | {intent: 'pause' | 'resume' | 'skip' | 'stop' | 'clear'}
  | {intent: 'unknown'};

const SPOKEN_WAKE_WORDS: Record<string, string[]> = {
  hey_jarvis: ['hey jarvis', 'jarvis'],
  alexa: ['alexa'],
  hey_mycroft: ['hey mycroft'],
  hey_rhasspy: ['hey rhasspy'],
  timer: ['timer'],
  weather: ['weather'],
};

@injectable()
export default class VoiceCommandService {
  constructor(@inject(TYPES.Managers.Player) private readonly playerManager: PlayerManager,
    @inject(TYPES.Services.AddQueryToQueue) private readonly addQueryToQueue: AddQueryToQueue,
    @inject(TYPES.Config) private readonly config: Config) {}

  private log(message: string): void {
    if (!this.config.VOICE_COMMANDS_DEBUG) {
      return;
    }

    console.info(`[voice-debug] ${message}`);
  }

  public async handleTranscript({
    guildId,
    userId,
    transcript,
    wakeWord,
  }: {
    guildId: string;
    userId: string;
    transcript: string;
    wakeWord: string;
  }): Promise<void> {
    this.log(`routing transcript guild=${guildId} user=${userId} raw="${transcript}" wakeWord=${wakeWord}`);
    const cleanedTranscript = this.stripWakeWord(transcript, wakeWord);
    this.log(`cleaned transcript="${cleanedTranscript}"`);

    if (cleanedTranscript === '') {
      this.log('ignoring transcript after wake-word stripping because it is empty');
      return;
    }

    const command = this.parseCommand(cleanedTranscript);
    this.log(`parsed intent=${command.intent}${'query' in command ? ` query="${command.query}"` : ''}`);

    if (command.intent === 'unknown') {
      this.log(`ignored unknown command from transcript="${cleanedTranscript}"`);
      debug(`voice command ignored: "${cleanedTranscript}"`);
      return;
    }

    const player = this.playerManager.get(guildId);
    const voiceChannel = player.getCurrentVoiceChannel();
    if (!voiceChannel) {
      this.log(`dropping command intent=${command.intent} because the bot is not connected to voice in guild=${guildId}`);
      debug(`voice command dropped for guild ${guildId}: bot is not in voice`);
      return;
    }

    try {
      switch (command.intent) {
        case 'play': {
          this.log(`executing play command for guild=${guildId} user=${userId} query="${command.query}" channel=${voiceChannel.id}`);
          await this.addQueryToQueue.addToQueueFromVoiceCommand({
            guildId,
            query: command.query,
            requestedBy: userId,
            targetVoiceChannel: voiceChannel,
            addedInChannelId: voiceChannel.id,
          });
          break;
        }

        case 'pause': {
          this.log(`executing pause command for guild=${guildId} playerStatus=${player.status.toString()}`);
          if (player.status === STATUS.PLAYING) {
            player.pause();
          }

          break;
        }

        case 'resume': {
          this.log(`executing resume command for guild=${guildId} playerStatus=${player.status.toString()} hasCurrent=${(player.getCurrent() !== null).toString()}`);
          if (player.getCurrent() && player.status !== STATUS.PLAYING) {
            await player.play();
          }

          break;
        }

        case 'skip': {
          this.log(`executing skip command for guild=${guildId} canGoForward=${player.canGoForward(1).toString()}`);
          if (player.canGoForward(1)) {
            await player.forward(1);
          }

          break;
        }

        case 'stop': {
          this.log(`executing stop command for guild=${guildId} connected=${(player.voiceConnection !== null).toString()}`);
          if (player.voiceConnection) {
            player.stop();
          }

          break;
        }

        case 'clear': {
          this.log(`executing clear command for guild=${guildId}`);
          player.clear();
          break;
        }
      }
    } catch (error: unknown) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.log(`voice command failed intent=${command.intent} error="${normalizedError.message}"`);
      debug(normalizedError);
      try {
        await voiceChannel.send(errorMsg(normalizedError));
      } catch (sendError) {
        debug(sendError as Error);
      }

      return;
    }

    this.log(`voice command completed intent=${command.intent}`);
    debug(`voice command executed: "${cleanedTranscript}"`);
  }

  private stripWakeWord(transcript: string, wakeWord: string): string {
    const normalizeForParsing = (value: string): string => value
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const normalizedTranscript = normalizeForParsing(transcript);
    const spokenWakeWords = SPOKEN_WAKE_WORDS[wakeWord] ?? [wakeWord];

    for (const spokenWakeWord of spokenWakeWords) {
      const escapedWakeWord = normalizeForParsing(spokenWakeWord).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = normalizedTranscript.match(new RegExp(`\\b${escapedWakeWord}\\b\\s*`, 'i'));
      if (match?.index !== undefined) {
        return normalizedTranscript.slice(match.index + match[0].length).trim();
      }
    }

    return normalizedTranscript;
  }

  private parseCommand(transcript: string): ParsedVoiceCommand {
    const normalized = transcript.toLowerCase();

    if (normalized.startsWith('play ')) {
      const query = transcript.slice(5).trim();
      if (query !== '') {
        return {intent: 'play', query};
      }
    }

    if (normalized === 'pause' || normalized.startsWith('pause ')) {
      return {intent: 'pause'};
    }

    if (normalized === 'resume' || normalized.startsWith('resume ')) {
      return {intent: 'resume'};
    }

    if (normalized === 'skip' || normalized === 'next' || normalized.startsWith('skip ') || normalized.startsWith('next ')) {
      return {intent: 'skip'};
    }

    if (normalized === 'stop' || normalized.startsWith('stop ')) {
      return {intent: 'stop'};
    }

    if (normalized === 'clear' || normalized.startsWith('clear ')) {
      return {intent: 'clear'};
    }

    return {intent: 'unknown'};
  }
}

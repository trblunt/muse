import {ChildProcessWithoutNullStreams, spawn} from 'node:child_process';
import {VoiceConnection, EndBehaviorType} from '@discordjs/voice';
import {inject, injectable} from 'inversify';
import WebSocket from 'ws';
import prism from 'prism-media';
import {VoiceChannel} from 'discord.js';
import {TYPES} from '../types.js';
import Config from './config.js';
import VoiceCommandService from './voice-command-service.js';
import debug from '../utils/debug.js';

interface SidecarTranscriptMessage {
  type: 'transcript';
  guildId: string;
  userId: string;
  wakeWord: string;
  text: string;
}

interface SidecarInfoMessage {
  type: 'ready' | 'error' | 'log';
  message: string;
}

interface ActiveReceiveStream {
  readonly streamId: string;
  readonly guildId: string;
  readonly userId: string;
  readonly cleanup: () => void;
  readonly startedAt: number;
  pcmRemainder: Buffer;
  frameBuffer: Buffer;
  finished: boolean;
  frameCount: number;
  audioBytesSent: number;
  maxAbsSample: number;
}

const OUTPUT_FRAME_BYTES = 2560;
const BYTES_PER_STEREO_SAMPLE = 4;
const DOWNSAMPLE_FACTOR = 3;

@injectable()
export default class VoiceCommandBridge {
  private readonly activeStreams = new Map<string, ActiveReceiveStream>();
  private readonly receiverCleanupByGuild = new Map<string, () => void>();
  private readonly sidecarUrl: string;
  private readonly enabled: boolean;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private sidecarProcess?: ChildProcessWithoutNullStreams;
  private started = false;
  private voiceCommandService?: VoiceCommandService;

  constructor(@inject(TYPES.Config) private readonly config: Config) {
    this.enabled = config.VOICE_COMMANDS_ENABLED;
    this.sidecarUrl = `ws://${config.VOICE_COMMANDS_SIDECAR_HOST}:${config.VOICE_COMMANDS_SIDECAR_PORT.toString()}`;
  }

  private log(message: string): void {
    if (!this.config.VOICE_COMMANDS_DEBUG) {
      return;
    }

    console.info(`[voice-debug] ${message}`);
  }

  public setVoiceCommandService(voiceCommandService: VoiceCommandService): void {
    this.voiceCommandService = voiceCommandService;
  }

  public get globallyEnabled(): boolean {
    return this.enabled;
  }

  public start(): void {
    if (!this.enabled || this.started) {
      return;
    }

    this.started = true;
    this.log(`voice commands enabled; autostartSidecar=${this.config.VOICE_COMMANDS_AUTOSTART_SIDECAR.toString()} sidecarUrl=${this.sidecarUrl}`);

    if (this.config.VOICE_COMMANDS_AUTOSTART_SIDECAR) {
      this.startSidecar();
    }

    this.connect();
  }

  public stop(): void {
    for (const guildId of this.receiverCleanupByGuild.keys()) {
      this.detach(guildId);
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = undefined;

    if (this.sidecarProcess) {
      this.sidecarProcess.kill('SIGTERM');
      this.sidecarProcess = undefined;
    }

    this.started = false;
  }

  public attach(guildId: string, voiceConnection: VoiceConnection, channel: VoiceChannel): void {
    if (!this.enabled) {
      return;
    }

    this.detach(guildId);

    const onSpeakingStart = (userId: string) => {
      void this.handleSpeakingStart({guildId, userId, voiceConnection, channel});
    };

    this.log(`attached receiver for guild=${guildId} channel=${channel.id} (${channel.name})`);
    voiceConnection.receiver.speaking.on('start', onSpeakingStart);
    this.receiverCleanupByGuild.set(guildId, () => {
      voiceConnection.receiver.speaking.off('start', onSpeakingStart);
    });
  }

  public detach(guildId: string): void {
    this.log(`detaching receiver for guild=${guildId}`);
    this.receiverCleanupByGuild.get(guildId)?.();
    this.receiverCleanupByGuild.delete(guildId);

    for (const [key, stream] of this.activeStreams) {
      if (stream.guildId === guildId) {
        this.finishStream(key);
      }
    }
  }

  private startSidecar(): void {
    if (this.sidecarProcess) {
      return;
    }

    this.log(`starting sidecar process with ${this.config.VOICE_COMMANDS_PYTHON_EXECUTABLE} ${this.config.VOICE_COMMANDS_SIDECAR_SCRIPT}`);
    this.sidecarProcess = spawn(
      this.config.VOICE_COMMANDS_PYTHON_EXECUTABLE,
      [this.config.VOICE_COMMANDS_SIDECAR_SCRIPT],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VOICE_COMMANDS_SIDECAR_HOST: this.config.VOICE_COMMANDS_SIDECAR_HOST,
          VOICE_COMMANDS_SIDECAR_PORT: this.config.VOICE_COMMANDS_SIDECAR_PORT.toString(),
          VOICE_COMMANDS_WAKE_WORD: this.config.VOICE_COMMANDS_WAKE_WORD,
          VOICE_COMMANDS_WAKE_WORD_THRESHOLD: this.config.VOICE_COMMANDS_WAKE_WORD_THRESHOLD.toString(),
          VOICE_COMMANDS_WHISPER_MODEL: this.config.VOICE_COMMANDS_WHISPER_MODEL,
          VOICE_COMMANDS_DEBUG: this.config.VOICE_COMMANDS_DEBUG.toString(),
        },
      },
    );

    this.sidecarProcess.stdout.on('data', chunk => {
      const message = chunk.toString().trim();
      if (message !== '') {
        this.log(`sidecar stdout: ${message}`);
        debug(`[voice-sidecar] ${message}`);
      }
    });

    this.sidecarProcess.stderr.on('data', chunk => {
      const message = chunk.toString().trim();
      if (message !== '') {
        this.log(`sidecar stderr: ${message}`);
        console.warn(`[voice-sidecar] ${message}`);
      }
    });

    this.sidecarProcess.on('exit', code => {
      this.log(`sidecar exited with code=${code?.toString() ?? 'unknown'}`);
      debug(`voice sidecar exited with code ${code?.toString() ?? 'unknown'}`);
      this.sidecarProcess = undefined;
    });
  }

  private connect(): void {
    if (!this.enabled || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.socket = new WebSocket(this.sidecarUrl);
    this.log(`connecting websocket to ${this.sidecarUrl}`);

    this.socket.on('open', () => {
      this.log(`websocket connected to ${this.sidecarUrl}`);
      debug(`voice sidecar connected at ${this.sidecarUrl}`);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
    });

    this.socket.on('message', event => {
      void this.handleSocketMessage(event.toString());
    });

    this.socket.on('close', () => {
      this.log('websocket closed');
      debug('voice sidecar websocket closed');
      this.scheduleReconnect();
    });

    this.socket.on('error', error => {
      this.log(`websocket error: ${(error as Error).message}`);
      debug(`voice sidecar websocket error: ${(error as Error).message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.enabled) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.log('retrying websocket connection');
      this.connect();
    }, 2000);
  }

  private async handleSocketMessage(rawMessage: string): Promise<void> {
    let message: SidecarTranscriptMessage | SidecarInfoMessage;

    try {
      message = JSON.parse(rawMessage) as SidecarTranscriptMessage | SidecarInfoMessage;
    } catch {
      debug(`voice sidecar sent invalid JSON: ${rawMessage}`);
      return;
    }

    if (message.type === 'transcript') {
      if (!this.voiceCommandService) {
        debug(`voice transcript dropped before handler initialization: ${message.text}`);
        return;
      }

      this.log(`received transcript guild=${message.guildId} user=${message.userId} wakeWord=${message.wakeWord} text="${message.text}"`);
      await this.voiceCommandService.handleTranscript({
        guildId: message.guildId,
        userId: message.userId,
        transcript: message.text,
        wakeWord: message.wakeWord,
      });
      return;
    }

    if (message.type === 'error') {
      this.log(`sidecar error: ${message.message}`);
      console.warn(`[voice-sidecar] ${message.message}`);
    } else {
      this.log(`sidecar info: ${message.message}`);
      debug(`[voice-sidecar] ${message.message}`);
    }
  }

  private async handleSpeakingStart({
    guildId,
    userId,
    voiceConnection,
    channel,
  }: {
    guildId: string;
    userId: string;
    voiceConnection: VoiceConnection;
    channel: VoiceChannel;
  }): Promise<void> {
    if (!this.isSocketOpen()) {
      this.log(`dropping speaking start for guild=${guildId} user=${userId}: websocket not open`);
      return;
    }

    const member = channel.members.get(userId);
    if (!member || member.user.bot) {
      this.log(`ignoring speaking start for guild=${guildId} user=${userId}: member missing or bot`);
      return;
    }

    const activeKey = `${guildId}:${userId}`;
    if (this.activeStreams.has(activeKey)) {
      this.log(`ignoring speaking start for ${activeKey}: stream already active`);
      return;
    }

    const opusStream = voiceConnection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 250,
      },
    });
    const decoder = new prism.opus.Decoder({rate: 48_000, channels: 2, frameSize: 960});
    const streamId = `${activeKey}:${Date.now().toString(36)}`;

    this.send({
      type: 'start',
      streamId,
      guildId,
      userId,
      wakeWord: this.config.VOICE_COMMANDS_WAKE_WORD,
    });

    const activeStream: ActiveReceiveStream = {
      streamId,
      guildId,
      userId,
      startedAt: Date.now(),
      pcmRemainder: Buffer.alloc(0),
      frameBuffer: Buffer.alloc(0),
      finished: false,
      frameCount: 0,
      audioBytesSent: 0,
      maxAbsSample: 0,
      cleanup: () => {
        opusStream.off('end', finish);
        opusStream.off('close', finish);
        opusStream.off('error', handleStreamError);
        decoder.off('data', handlePcmData);
        decoder.off('error', handleDecoderError);
        opusStream.unpipe(decoder);
        decoder.destroy();
      },
    };

    this.log(`starting receive stream ${streamId} for guild=${guildId} user=${userId} channel=${channel.id} (${channel.name})`);

    const finish = () => {
      this.finishStream(activeKey);
    };

    const handleStreamError = (error: Error) => {
      debug(`voice receive stream error for ${activeKey}: ${error.message}`);
      finish();
    };

    const handleDecoderError = (error: Error) => {
      debug(`voice decoder error for ${activeKey}: ${error.message}`);
      finish();
    };

    const handlePcmData = (chunk: Buffer) => {
      this.handleDecodedPcm(activeKey, chunk);
    };

    this.activeStreams.set(activeKey, activeStream);

    opusStream.on('end', finish);
    opusStream.on('close', finish);
    opusStream.on('error', handleStreamError);
    decoder.on('data', handlePcmData);
    decoder.on('error', handleDecoderError);

    opusStream.pipe(decoder);
  }

  private finishStream(activeKey: string): void {
    const activeStream = this.activeStreams.get(activeKey);
    if (!activeStream || activeStream.finished) {
      return;
    }

    activeStream.finished = true;

    if (activeStream.frameBuffer.length > 0) {
      activeStream.audioBytesSent += activeStream.frameBuffer.length;
      this.send({
        type: 'audio',
        streamId: activeStream.streamId,
        guildId: activeStream.guildId,
        userId: activeStream.userId,
        pcm: activeStream.frameBuffer.toString('base64'),
      });
    }

    this.send({
      type: 'stop',
      streamId: activeStream.streamId,
      guildId: activeStream.guildId,
      userId: activeStream.userId,
    });

    const durationMs = Date.now() - activeStream.startedAt;
    this.log(`finished stream ${activeStream.streamId} guild=${activeStream.guildId} user=${activeStream.userId} durationMs=${durationMs} frames=${activeStream.frameCount.toString()} bytesSent=${activeStream.audioBytesSent.toString()} maxAbsSample=${activeStream.maxAbsSample.toString()}`);
    activeStream.cleanup();
    this.activeStreams.delete(activeKey);
  }

  private handleDecodedPcm(activeKey: string, chunk: Buffer): void {
    const activeStream = this.activeStreams.get(activeKey);
    if (!activeStream) {
      return;
    }

    const combined = Buffer.concat([activeStream.pcmRemainder, chunk]);
    const processableBytes = combined.length - (combined.length % (BYTES_PER_STEREO_SAMPLE * DOWNSAMPLE_FACTOR));
    activeStream.pcmRemainder = combined.subarray(processableBytes);

    if (processableBytes === 0) {
      return;
    }

    const downsampledChunk = this.downsampleToMono16Khz(combined.subarray(0, processableBytes));
    activeStream.frameBuffer = Buffer.concat([activeStream.frameBuffer, downsampledChunk]);

    for (let offset = 0; offset < downsampledChunk.length; offset += 2) {
      const sample = Math.abs(downsampledChunk.readInt16LE(offset));
      if (sample > activeStream.maxAbsSample) {
        activeStream.maxAbsSample = sample;
      }
    }

    while (activeStream.frameBuffer.length >= OUTPUT_FRAME_BYTES) {
      const frame = activeStream.frameBuffer.subarray(0, OUTPUT_FRAME_BYTES);
      activeStream.frameBuffer = activeStream.frameBuffer.subarray(OUTPUT_FRAME_BYTES);
      activeStream.frameCount++;
      activeStream.audioBytesSent += frame.length;

      if (this.config.VOICE_COMMANDS_DEBUG && activeStream.frameCount % 10 === 0) {
        this.log(`stream ${activeStream.streamId} sent ${activeStream.frameCount.toString()} frames (${activeStream.audioBytesSent.toString()} bytes) maxAbsSample=${activeStream.maxAbsSample.toString()}`);
      }

      this.send({
        type: 'audio',
        streamId: activeStream.streamId,
        guildId: activeStream.guildId,
        userId: activeStream.userId,
        pcm: frame.toString('base64'),
      });
    }
  }

  private downsampleToMono16Khz(input: Buffer): Buffer {
    const outputSamples = input.length / (BYTES_PER_STEREO_SAMPLE * DOWNSAMPLE_FACTOR);
    const output = Buffer.allocUnsafe(outputSamples * 2);

    for (let outputIndex = 0; outputIndex < outputSamples; outputIndex++) {
      const inputOffset = outputIndex * BYTES_PER_STEREO_SAMPLE * DOWNSAMPLE_FACTOR;
      let sampleTotal = 0;

      for (let step = 0; step < DOWNSAMPLE_FACTOR; step++) {
        const frameOffset = inputOffset + (step * BYTES_PER_STEREO_SAMPLE);
        const left = input.readInt16LE(frameOffset);
        const right = input.readInt16LE(frameOffset + 2);
        sampleTotal += Math.round((left + right) / 2);
      }

      const monoSample = Math.max(Math.min(Math.round(sampleTotal / DOWNSAMPLE_FACTOR), 32_767), -32_768);
      output.writeInt16LE(monoSample, outputIndex * 2);
    }

    return output;
  }

  private send(payload: Record<string, string>): void {
    if (!this.isSocketOpen()) {
      this.log(`dropping payload type=${payload.type ?? 'unknown'}: websocket not open`);
      return;
    }

    this.socket!.send(JSON.stringify(payload));
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}

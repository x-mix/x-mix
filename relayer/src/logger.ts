import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';

function resolveTimeZone(value: string | undefined): string {
  const fallback = 'Asia/Shanghai';
  const tz = value?.trim();
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

function formatDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error('failed to format log date key');
  }

  return `${year}-${month}-${day}`;
}

class DailyFileStream extends Writable {
  private currentDateKey = '';
  private currentStream: fs.WriteStream | null = null;

  constructor(
    private readonly logDir: string,
    private readonly filePrefix: string,
    private readonly timeZone: string
  ) {
    super();
  }

  private ensureStream(now: Date): fs.WriteStream {
    const dateKey = formatDateKey(now, this.timeZone);
    if (this.currentStream && this.currentDateKey === dateKey) {
      return this.currentStream;
    }

    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }

    fs.mkdirSync(this.logDir, { recursive: true });
    const filePath = path.join(this.logDir, `${this.filePrefix}-${dateKey}.log`);
    this.currentStream = fs.createWriteStream(filePath, { flags: 'a' });
    this.currentDateKey = dateKey;
    return this.currentStream;
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    try {
      const stream = this.ensureStream(new Date());
      if (stream.write(chunk, encoding)) {
        callback();
      } else {
        stream.once('drain', () => callback());
      }
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.currentStream) {
      callback();
      return;
    }

    this.currentStream.end(() => callback());
    this.currentStream = null;
  }
}

const logLevel = process.env.LOG_LEVEL?.trim() || 'info';
const logDir = path.resolve(process.env.LOG_DIR?.trim() || './relayer-data/logs');
const logFilePrefix = process.env.LOG_FILE_PREFIX?.trim() || 'relayer';
const logTimeZone = resolveTimeZone(process.env.LOG_TIMEZONE);

const destination = new DailyFileStream(logDir, logFilePrefix, logTimeZone);

export const logger = pino(
  {
    level: logLevel,
  },
  destination
);

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  GetResult,
  PutOptions,
  SignUrlOptions,
  StatResult,
  Storage,
  StorageNotFoundError,
  normalizeKey,
} from './types.js';

/**
 * Local filesystem storage backend.
 *
 * Object `key` `titles/42/hls/master.m3u8` maps to `<root>/titles/42/hls/master.m3u8`.
 * `signUrl` returns a plain URL under `cdnBaseUrl` — nginx (or any static file
 * server) serves the same directory, which is what makes local playback work.
 */
export class LocalFileStorage implements Storage {
  readonly backend = 'local' as const;

  constructor(
    private readonly root: string,
    private readonly cdnBaseUrl: string,
  ) {
    this.root = resolve(root);
  }

  /** Absolute on-disk path for a key. */
  localPath(key: string): string {
    return join(this.root, normalizeKey(key));
  }

  async put(key: string, stream: NodeJS.ReadableStream, _options?: PutOptions): Promise<StatResult> {
    const target = this.localPath(key);
    await mkdir(dirname(target), { recursive: true });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const out = createWriteStream(target);
      stream.pipe(out);
      out.on('finish', () => resolvePromise());
      out.on('error', rejectPromise);
      stream.on('error', rejectPromise);
    });
    const s = await stat(target);
    return { size: s.size, modifiedAt: s.mtime };
  }

  async getBuffer(key: string): Promise<Buffer> {
    const target = this.localPath(key);
    try {
      return await import('node:fs/promises').then((fs) => fs.readFile(target));
    } catch (err) {
      throw new StorageNotFoundError(key);
    }
  }

  get(key: string): Promise<GetResult> {
    const target = this.localPath(key);
    return stat(target).then(
      (s) => ({ stream: createReadStream(target), length: s.size }),
      () => {
        throw new StorageNotFoundError(key);
      },
    );
  }

  async stat(key: string): Promise<StatResult> {
    const target = this.localPath(key);
    try {
      const s = await stat(target);
      return { size: s.size, modifiedAt: s.mtime };
    } catch {
      throw new StorageNotFoundError(key);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const target = this.localPath(prefix);
    let removed = 0;
    try {
      const s = await stat(target);
      if (s.isDirectory()) {
        await rm(target, { recursive: true, force: true });
        return -1; // directory removals are not counted individually
      }
      await rm(target, { force: true });
      removed = 1;
    } catch {
      // absent — nothing to remove
    }
    return removed;
  }

  async signUrl(_key: string, _options: SignUrlOptions): Promise<string> {
    // never used: local playback URLs are built by the API playback module
    throw new Error('signUrl is not implemented for the local backend; build URLs from cdnBaseUrl');
  }

  async putFile(key: string, localPath: string, _options?: PutOptions): Promise<StatResult> {
    const target = this.localPath(key);
    await mkdir(dirname(target), { recursive: true });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(localPath, target);
    const s = await stat(target);
    return { size: s.size, modifiedAt: s.mtime };
  }

  /** Used by tests. */
  async writeBufferForTest(key: string, buf: Buffer): Promise<void> {
    const target = this.localPath(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buf);
  }
}

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, link, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256Hex } from "./hash.js";

export interface CasPutResult {
  hash: string; // sha256 hex
  bytes: number;
}

export interface CAS {
  rootDir(): string;
  objectPath(hash: string): string;
  putBytes(bytes: Uint8Array): Promise<CasPutResult>;
  putStream(stream: NodeJS.ReadableStream): Promise<CasPutResult>;
  putFile(filePath: string): Promise<CasPutResult>;
}

export class LocalCAS implements CAS {
  private readonly objectsDir: string;
  private readonly tmpDir: string;

  constructor(private readonly baseDir: string) {
    this.objectsDir = path.join(baseDir, "objects");
    this.tmpDir = path.join(baseDir, "tmp");
  }

  rootDir(): string {
    return this.baseDir;
  }

  objectPath(hash: string): string {
    assertSha256Hex(hash);
    const prefix = hash.slice(0, 2);
    const suffix = hash.slice(2);
    return path.join(this.objectsDir, prefix, suffix);
  }

  async putBytes(bytes: Uint8Array): Promise<CasPutResult> {
    const hash = sha256Hex(bytes);
    const outPath = this.objectPath(hash);
    await mkdir(path.dirname(outPath), { recursive: true });
    try {
      await writeFile(outPath, bytes, { flag: "wx" });
    } catch (err) {
      if (!isErrno(err, "EEXIST")) throw err;
    }
    return { hash, bytes: bytes.byteLength };
  }

  async putStream(stream: NodeJS.ReadableStream): Promise<CasPutResult> {
    await mkdir(this.tmpDir, { recursive: true });
    const tmpPath = path.join(this.tmpDir, `cas_${Date.now()}_${Math.random().toString(16).slice(2)}`);

    const hash = createHash("sha256");
    let bytes = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        const buf = chunk as Buffer;
        hash.update(buf);
        bytes += buf.byteLength;
        cb(null, buf);
      }
    });

    try {
      await pipeline(stream, tap, createWriteStream(tmpPath));
      const digest = hash.digest("hex");
      const outPath = this.objectPath(digest);
      await mkdir(path.dirname(outPath), { recursive: true });
      try {
        await link(tmpPath, outPath);
      } catch (err) {
        if (!isErrno(err, "EEXIST")) throw err;
      } finally {
        await unlink(tmpPath).catch(() => undefined);
      }
      return { hash: digest, bytes };
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  async putFile(filePath: string): Promise<CasPutResult> {
    await mkdir(this.tmpDir, { recursive: true });
    const tmpPath = path.join(this.tmpDir, `cas_${Date.now()}_${Math.random().toString(16).slice(2)}`);

    const hash = createHash("sha256");
    let bytes = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        const buf = chunk as Buffer;
        hash.update(buf);
        bytes += buf.byteLength;
        cb(null, buf);
      }
    });

    try {
      await pipeline(createReadStream(filePath), tap, createWriteStream(tmpPath));
      const digest = hash.digest("hex");
      const outPath = this.objectPath(digest);
      await mkdir(path.dirname(outPath), { recursive: true });
      try {
        await link(tmpPath, outPath);
      } catch (err) {
        if (!isErrno(err, "EEXIST")) throw err;
      } finally {
        await unlink(tmpPath).catch(() => undefined);
      }
      return { hash: digest, bytes };
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}

export function sha256Uri(hash: string): string {
  assertSha256Hex(hash);
  return `sha256:${hash}`;
}

export function parseSha256Uri(uri: string): string {
  const m = /^sha256:([a-f0-9]{64})$/.exec(uri);
  if (!m) throw new Error(`Expected sha256:<hex> uri; got ${uri}`);
  return m[1]!;
}

function assertSha256Hex(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid sha256 hex: ${hash}`);
}

function isErrno(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string" &&
    (err as { code: string }).code === code
  );
}

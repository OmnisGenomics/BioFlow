import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stableStringify } from "./stable-json.js";

export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export async function sha256FileHex(filePath: string): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      bytes += buf.byteLength;
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { hash: hash.digest("hex"), bytes };
}

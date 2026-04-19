import type { Readable, Writable } from "node:stream";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");

export class RpcFramer {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer<ArrayBufferLike>): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) break;

      const headerBlock = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(headerBlock);
      if (contentLength === null) {
        throw new Error("Missing Content-Length header");
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      const raw = body.toString("utf8");
      messages.push(JSON.parse(raw) as unknown);
    }

    return messages;
  }
}

export function encodeJsonRpcFrame(message: JsonRpcRequest | JsonRpcResponse): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

export async function serveStdio(
  stdin: Readable,
  stdout: Writable,
  handleMessage: (message: unknown) => Promise<JsonRpcResponse | null>
): Promise<void> {
  const framer = new RpcFramer();

  return new Promise<void>((resolve, reject) => {
    let pendingResponses = 0;
    let closed = false;

    const maybeResolve = (): void => {
      if (closed && pendingResponses === 0) {
        resolve();
      }
    };

    stdin.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      let messages: unknown[];
      try {
        messages = framer.push(chunk);
      } catch (error) {
        const frame = encodeJsonRpcFrame({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: error instanceof Error ? error.message : "Parse error"
          }
        });
        stdout.write(frame);
        return;
      }

      for (const message of messages) {
        pendingResponses++;
        void handleMessage(message)
          .then((response) => {
            if (!response) return;
            stdout.write(encodeJsonRpcFrame(response));
          })
          .catch((error) => {
            const response = {
              jsonrpc: "2.0" as const,
              id: null,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : "Internal error",
                data: error instanceof Error ? { stack: error.stack } : undefined
              }
            };
            stdout.write(encodeJsonRpcFrame(response));
          })
          .finally(() => {
            pendingResponses--;
            maybeResolve();
          });
      }
    });

    stdin.on("end", () => {
      closed = true;
      maybeResolve();
    });
    stdin.on("close", () => {
      closed = true;
      maybeResolve();
    });
    stdin.on("error", reject);
    stdout.on("error", reject);
  });
}

function parseContentLength(headerBlock: string): number | null {
  for (const line of headerBlock.split(/\r?\n/)) {
    const match = line.match(/^Content-Length:\s*(\d+)\s*$/i);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

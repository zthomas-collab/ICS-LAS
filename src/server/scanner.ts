import net from "node:net";

/**
 * Malware scanning boundary. Uploaded documents are quarantined until a scan returns CLEAN.
 *
 *   SCANNER = clamd | none              (default none; production requires clamd)
 *   CLAMD_HOST, CLAMD_PORT (3310)       a reachable ClamAV daemon (self-hosted, or a managed clamd service)
 *
 * Fail closed: any scanner error is reported as FAILED, never CLEAN.
 */
export type ScanResult = { status: "CLEAN" | "INFECTED" | "FAILED"; detail?: string };
export interface Scanner {
  readonly name: string;
  /** False when no real scanning happens (development only). */
  readonly effective: boolean;
  scan(bytes: Buffer): Promise<ScanResult>;
}

const CHUNK = 64 * 1024;

/** ClamAV INSTREAM protocol: "zINSTREAM\0", then [4-byte big-endian length][data]..., then a zero length. */
export class ClamdScanner implements Scanner {
  readonly name = "clamd";
  readonly effective = true;
  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let response = "";
      let settled = false;
      const done = (r: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(this.timeoutMs, () => done({ status: "FAILED", detail: "scanner timeout" }));
      socket.on("error", () => done({ status: "FAILED", detail: "scanner unreachable" }));
      socket.on("data", (d) => {
        response += d.toString("latin1");
        if (response.includes("\0") || response.includes("\n")) {
          const text = response.replace(/[\0\n]+$/g, "").trim();
          if (/\bOK$/.test(text)) done({ status: "CLEAN" });
          else if (/FOUND$/.test(text)) done({ status: "INFECTED", detail: text.replace(/^stream:\s*/, "").slice(0, 120) });
          else done({ status: "FAILED", detail: "scanner error" });
        }
      });
      socket.on("close", () => done({ status: "FAILED", detail: "scanner closed connection" }));
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const chunk = bytes.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // end of stream
      });
    });
  }
}

class NoScanner implements Scanner {
  readonly name = "none";
  readonly effective = false;
  async scan(): Promise<ScanResult> {
    return { status: "FAILED", detail: "no scanner configured" };
  }
}

export function createScanner(env: Record<string, string | undefined> = process.env): Scanner {
  const kind = env.SCANNER ?? "none";
  if (kind === "none") return new NoScanner();
  if (kind !== "clamd") throw new Error(`Unknown SCANNER "${kind}".`);
  if (!env.CLAMD_HOST) throw new Error("CLAMD_HOST is required when SCANNER=clamd.");
  const port = env.CLAMD_PORT ? Number(env.CLAMD_PORT) : 3310;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CLAMD_PORT is invalid.");
  return new ClamdScanner(env.CLAMD_HOST, port);
}

const globalForScanner = globalThis as unknown as { __icsScanner?: Scanner };
export function getScanner(): Scanner {
  if (!globalForScanner.__icsScanner) globalForScanner.__icsScanner = createScanner();
  return globalForScanner.__icsScanner;
}

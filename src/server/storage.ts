import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Object storage boundary. Development uses the local filesystem (./.data/uploads).
 * Production must use managed private object storage (missing input M5); the local
 * store refuses to run in production unless explicitly allowed.
 */
export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9-]+\/[0-9a-f-]{36}\.webp$/;

export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!KEY_RE.test(key)) throw new Error("invalid storage key");
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("invalid storage key");
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes, { flag: "wx" });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

const globalForStore = globalThis as unknown as { __icsStore?: ObjectStore };

export function getObjectStore(): ObjectStore {
  if (!globalForStore.__icsStore) {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_OBJECT_STORE !== "true") {
      throw new Error("Configure managed object storage for production (local store is development-only).");
    }
    const root =
      process.env.UPLOADS_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "uploads");
    globalForStore.__icsStore = new LocalObjectStore(root);
  }
  return globalForStore.__icsStore;
}

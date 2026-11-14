import net from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES, prepareDocument, safeDisplayName, scanDocument } from "@/server/documents";
import { ClamdScanner, createScanner } from "@/server/scanner";
import { createObjectStore, LocalObjectStore, S3ObjectStore } from "@/server/storage";

// A minimal clamd that speaks INSTREAM, to test our client without a real ClamAV.
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
function fakeClamd(mode: "normal" | "hangup" | "error"): Promise<{ port: number; close: () => void; seen: () => Buffer }> {
  let lastPayload = Buffer.alloc(0);
  const server = net.createServer((sock) => {
    if (mode === "hangup") return void sock.destroy();
    let buf = Buffer.alloc(0);
    let started = false;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        const i = buf.indexOf(0);
        if (i < 0) return;
        if (buf.subarray(0, i).toString() !== "zINSTREAM") return void sock.destroy();
        buf = buf.subarray(i + 1);
        started = true;
      }
      const chunks: Buffer[] = [];
      let off = 0;
      while (buf.length - off >= 4) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          lastPayload = Buffer.concat(chunks);
          const reply = mode === "error" ? "INSTREAM size limit exceeded. ERROR" : lastPayload.includes(EICAR) ? "stream: Eicar-Test-Signature FOUND" : "stream: OK";
          sock.write(reply + "\0");
          return;
        }
        if (buf.length - off - 4 < len) break;
        chunks.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close(), seen: () => lastPayload }),
    ),
  );
}

describe("ClamAV client", () => {
  let ok: Awaited<ReturnType<typeof fakeClamd>>, hang: typeof ok, err: typeof ok;
  beforeAll(async () => {
    [ok, hang, err] = await Promise.all([fakeClamd("normal"), fakeClamd("hangup"), fakeClamd("error")]);
  });
  afterAll(() => [ok, hang, err].forEach((s) => s.close()));

  it("reports CLEAN for a clean file and streams every byte, including multi-chunk files", async () => {
    const big = Buffer.alloc(200_000, 7);
    expect(await new ClamdScanner("127.0.0.1", ok.port).scan(big)).toEqual({ status: "CLEAN" });
    expect(ok.seen().equals(big)).toBe(true);
  });

  it("reports INFECTED with the signature name for the EICAR test file", async () => {
    const r = await new ClamdScanner("127.0.0.1", ok.port).scan(Buffer.from(EICAR));
    expect(r.status).toBe("INFECTED");
    expect(r.detail).toContain("Eicar-Test-Signature");
  });

  it("fails closed: errors, hang-ups and unreachable scanners are never CLEAN", async () => {
    expect((await new ClamdScanner("127.0.0.1", err.port).scan(Buffer.from("x"))).status).toBe("FAILED");
    expect((await new ClamdScanner("127.0.0.1", hang.port).scan(Buffer.from("x"))).status).toBe("FAILED");
    const closed = await fakeClamd("normal");
    const port = closed.port;
    closed.close();
    expect((await new ClamdScanner("127.0.0.1", port, 2000).scan(Buffer.from("x"))).status).toBe("FAILED");
  });

  it("configuration is validated", () => {
    expect(createScanner({}).effective).toBe(false);
    expect(() => createScanner({ SCANNER: "clamd" })).toThrow(/CLAMD_HOST/);
    expect(() => createScanner({ SCANNER: "clamd", CLAMD_HOST: "h", CLAMD_PORT: "99999" })).toThrow(/CLAMD_PORT/);
    expect(() => createScanner({ SCANNER: "magic" })).toThrow(/Unknown/);
    expect(createScanner({ SCANNER: "clamd", CLAMD_HOST: "clam.internal" }).effective).toBe(true);
  });
});

describe("scanning policy", () => {
  it("production refuses uploads without an effective scanner; development records NOT_SCANNED", async () => {
    const none = createScanner({});
    await expect(scanDocument(none, Buffer.from("x"), { NODE_ENV: "production" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await scanDocument(none, Buffer.from("x"), { NODE_ENV: "development" })).toMatchObject({ status: "NOT_SCANNED" });
  });
});

describe("document intake", () => {
  const png = () => sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#884400" } }).png().toBuffer();
  const pdf = (extra = "") => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog${extra}>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`);

  it("re-encodes images to bounded WebP and strips metadata", async () => {
    const withExif = await sharp(await png()).withExif({ IFD0: { Copyright: "secret-owner" } }).jpeg().toBuffer();
    const d = await prepareDocument(withExif, "../../Passport Scan.JPG");
    expect(d).toMatchObject({ ext: "webp", contentType: "image/webp", displayName: "Passport Scan.webp" });
    const meta = await sharp(d.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2400);
    expect(meta.exif).toBeUndefined();
    expect(d.bytes.includes(Buffer.from("secret-owner"))).toBe(false);
  });

  it("accepts a plain PDF and rejects active content", async () => {
    expect((await prepareDocument(pdf(), "letter.pdf")).ext).toBe("pdf");
    for (const bad of ["/JavaScript (app.alert(1))", "/OpenAction 2 0 R", "/Launch", "/EmbeddedFile", "/JS (x)"]) {
      await expect(prepareDocument(pdf(bad), "x.pdf"), bad).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("identifies files by content: disguised or unsupported files are refused", async () => {
    for (const bytes of [Buffer.from("<svg onload=alert(1)>"), Buffer.from("MZ\x90\x00 fake exe"), Buffer.from("<html><script>1</script>"), Buffer.alloc(0)]) {
      await expect(prepareDocument(bytes, "report.pdf")).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(prepareDocument(Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 1), "big.pdf")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("display names cannot carry paths, control characters or header injection", () => {
    expect(safeDisplayName('..\\..\\evil"\r\nSet-Cookie: x.pdf', "pdf")).not.toMatch(/[\\/"\r\n]/);
    expect(safeDisplayName("", "pdf")).toBe("document.pdf");
    expect(safeDisplayName("résumé final.docx", "pdf")).toBe("resume final.pdf");
  });
});

describe("object stores", () => {
  const key = "documents/123e4567-e89b-12d3-a456-426614174000.pdf";

  it("S3 store uses private, encrypted, no-overwrite writes and refuses non-generated keys", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const blobs = new Map<string, Buffer>();
    const fake = {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        const k = String(cmd.input.Key);
        if (cmd.constructor.name === "PutObjectCommand") blobs.set(k, cmd.input.Body as Buffer);
        if (cmd.constructor.name === "GetObjectCommand") {
          const b = blobs.get(k);
          if (!b) throw Object.assign(new Error("nope"), { name: "NoSuchKey" });
          return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
        }
        if (cmd.constructor.name === "DeleteObjectCommand") blobs.delete(k);
        return {};
      },
    };
    const store = new S3ObjectStore(fake, "private-bucket", "prod/");
    await store.put(key, Buffer.from("pdf-bytes"), "application/pdf");
    expect(calls[0].input).toMatchObject({ Bucket: "private-bucket", Key: `prod/${key}`, ServerSideEncryption: "AES256", IfNoneMatch: "*", CacheControl: "private, no-store" });
    expect((await store.get(key))?.toString()).toBe("pdf-bytes");
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await expect(store.put("../etc/passwd", Buffer.from("x"), "x")).rejects.toThrow(/invalid storage key/);
    await expect(store.get("documents/not-a-uuid.pdf")).rejects.toThrow(/invalid storage key/);
  });

  it("selects the store from configuration and refuses an unconfigured production", () => {
    expect(createObjectStore({ S3_BUCKET: "b", S3_REGION: "us-east-1" })).toBeInstanceOf(S3ObjectStore);
    expect(createObjectStore({})).toBeInstanceOf(LocalObjectStore);
    expect(() => createObjectStore({ NODE_ENV: "production" })).toThrow(/S3_BUCKET/);
  });
});

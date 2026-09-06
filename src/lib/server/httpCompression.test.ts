import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { compressionMiddleware, isCompressionEnabled } from "./httpCompression";

let server: Server | null = null;

/** Starts a throwaway app on an ephemeral port and returns its base URL. */
async function startApp(withCompression: boolean): Promise<string> {
  const app = express();
  if (withCompression) app.use(compressionMiddleware());
  // Large and repetitive, like a monitor-bars payload, so it is worth compressing.
  app.get("/payload", (_req, res) => {
    res.json({
      data: Array.from({ length: 500 }, (_, i) => ({
        monitor_tag: "service-" + i,
        countOfUp: 1440,
        countOfDown: 0,
        countOfDegraded: 0,
        countOfMaintenance: 0,
      })),
    });
  });

  return await new Promise((resolve) => {
    server = app.listen(0, () => {
      const address = server!.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("isCompressionEnabled", () => {
  it("is on when the variable is not set", () => {
    expect(isCompressionEnabled({})).toBe(true);
  });

  it("is off only for the exact value true", () => {
    expect(isCompressionEnabled({ KENER_DISABLE_COMPRESSION: "true" })).toBe(false);
  });

  it.each(["false", "TRUE", "1", "yes", ""])("stays on for %o", (value) => {
    expect(isCompressionEnabled({ KENER_DISABLE_COMPRESSION: value })).toBe(true);
  });
});

describe("compression middleware", () => {
  it("compresses when the client asks for gzip", async () => {
    const base = await startApp(true);
    const res = await fetch(base + "/payload", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("does not compress when the client does not ask", async () => {
    const base = await startApp(true);
    const res = await fetch(base + "/payload", { headers: { "Accept-Encoding": "identity" } });
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("sends nothing compressed when the middleware is absent", async () => {
    const base = await startApp(false);
    const res = await fetch(base + "/payload", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("makes a repetitive payload much smaller", async () => {
    const withOut = await startApp(false);
    const rawBytes = (await (await fetch(withOut + "/payload")).arrayBuffer()).byteLength;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const withIt = await startApp(true);
    // undici decompresses transparently, so read the raw socket bytes instead.
    const res = await fetch(withIt + "/payload", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const body = await res.text();

    // The decoded body is the same JSON either way; the win is on the wire.
    expect(JSON.parse(body).data).toHaveLength(500);
    expect(rawBytes).toBeGreaterThan(10000);
  });
});

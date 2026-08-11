import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function encryptCredential(secret, plaintext) {
  const iv = randomBytes(12);
  const salt = createHash("sha256").update(secret).digest().slice(0, 16);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("hex")}:${ciphertext.toString("hex")}:${tag.toString("hex")}`;
}

test("bootstrap recovers a matching Windows AppData storage key for an explicitly selected DATA_DIR", async () => {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    return test.skip("better-sqlite3 is unavailable in this runtime");
  }

  const root = mkdtempSync(join(tmpdir(), "omniroute-bootstrap-win-"));
  const dataDir = join(root, "legacy-data");
  const appData = join(root, "AppData", "Roaming");
  const appDataOmniRoute = join(appData, "omniroute");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(appDataOmniRoute, { recursive: true });

  const storageKey = "bootstrap-storage-key-compat-test";
  writeFileSync(
    join(appDataOmniRoute, "server.env"),
    `STORAGE_ENCRYPTION_KEY=${storageKey}\n`,
    "utf8"
  );

  const db = new Database(join(dataDir, "storage.sqlite"));
  db.exec(`
    CREATE TABLE provider_connections (
      api_key TEXT,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT
    )
  `);
  db.prepare("INSERT INTO provider_connections (api_key) VALUES (?)").run(
    encryptCredential(storageKey, "provider-test-key")
  );
  db.close();

  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalEnv = { ...process.env };

  try {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    process.env.DATA_DIR = dataDir;
    process.env.APPDATA = appData;
    delete process.env.STORAGE_ENCRYPTION_KEY;
    delete process.env.JWT_SECRET;
    delete process.env.API_KEY_SECRET;
    delete process.env.STORAGE_ENCRYPTION_KEY_VERSION;

    const { bootstrapEnv } = await import(
      `../../../scripts/build/bootstrap-env.mjs?windows-storage-key-compat=${Date.now()}`
    );
    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.STORAGE_ENCRYPTION_KEY, storageKey);
    assert.equal(env.DATA_DIR, dataDir);

    const activeServerEnv = readFileSync(join(dataDir, "server.env"), "utf8");
    assert.doesNotMatch(activeServerEnv, /provider-test-key/);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap rejects a Windows AppData storage key that does not match the active encrypted database", async () => {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    return test.skip("better-sqlite3 is unavailable in this runtime");
  }

  const root = mkdtempSync(join(tmpdir(), "omniroute-bootstrap-win-mismatch-"));
  const dataDir = join(root, "legacy-data");
  const appData = join(root, "AppData", "Roaming");
  const appDataOmniRoute = join(appData, "omniroute");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(appDataOmniRoute, { recursive: true });

  const correctKey = "correct-storage-key";
  writeFileSync(
    join(appDataOmniRoute, "server.env"),
    "STORAGE_ENCRYPTION_KEY=wrong-storage-key\n",
    "utf8"
  );

  const db = new Database(join(dataDir, "storage.sqlite"));
  db.exec(`
    CREATE TABLE provider_connections (
      api_key TEXT,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT
    )
  `);
  db.prepare("INSERT INTO provider_connections (api_key) VALUES (?)").run(
    encryptCredential(correctKey, "provider-test-key")
  );
  db.close();

  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalEnv = { ...process.env };

  try {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    process.env.DATA_DIR = dataDir;
    process.env.APPDATA = appData;
    delete process.env.STORAGE_ENCRYPTION_KEY;

    const { bootstrapEnv } = await import(
      `../../../scripts/build/bootstrap-env.mjs?windows-storage-key-mismatch=${Date.now()}`
    );

    assert.throws(
      () => bootstrapEnv({ quiet: true }),
      /Refusing to auto-generate STORAGE_ENCRYPTION_KEY/
    );
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

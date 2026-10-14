import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secrets at rest. Each value is sealed with AES-256-GCM under ECHOMIND_DATA_KEY and bound to
 * what it is (`aad`, e.g. "<person id>:refresh"), so a sealed value copied into another row
 * does not open.
 */

const VERSION = 1;

export function seal(key: Buffer, plaintext: string, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function unseal(key: Buffer, sealed: Uint8Array, aad: string): string {
  const data = Buffer.from(sealed);
  if (data[0] !== VERSION) throw new Error("unknown sealed format");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(data.subarray(13, 29));
  return Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]).toString("utf8");
}

export const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

/** An EchoMind session token: 256 random bits. */
export const newSessionToken = (): string => `ems_${randomBytes(32).toString("base64url")}`;

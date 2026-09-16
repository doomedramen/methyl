import { sha256 } from "@noble/hashes/sha2.js";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(sha256(bytes));
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

export async function sha256Incremental(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<string> {
  const hasher = sha256.create();
  for await (const chunk of chunks) {
    hasher.update(chunk);
  }
  return bytesToHex(hasher.digest());
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
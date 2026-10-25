import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** sha256 of LF-normalized content, first 12 hex chars. CRLF checkouts hash the same as LF ones. */
export function hashContent(content: string | Buffer): string {
  const text = typeof content === "string" ? content : content.toString("utf8");
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);
}

export function hashFile(path: string): string | null {
  try {
    return hashContent(readFileSync(path));
  } catch {
    return null;
  }
}

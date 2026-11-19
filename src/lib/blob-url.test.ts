import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalBlobUrl } from "./blob-url";

const host = "abc123.private.blob.vercel-storage.com";

test("a Blob URL matching its pathname comes back in canonical form", () => {
  assert.equal(canonicalBlobUrl(`https://${host}/files/Acme%20MSA-x1y2.txt`, "files/Acme MSA-x1y2.txt"), `https://${host}/files/Acme%20MSA-x1y2.txt`);
  assert.equal(canonicalBlobUrl(`https://ABC123.Private.Blob.Vercel-Storage.com/files/a.pdf`, "files/a.pdf"), `https://${host}/files/a.pdf`);
});

test("other spellings of the same file are refused", () => {
  for (const url of [`https://${host}/files/a.pdf?x=1`, `https://${host}/files/a.pdf#x`, `https://u:p@${host}/files/a.pdf`, `http://${host}/files/a.pdf`])
    assert.equal(canonicalBlobUrl(url, "files/a.pdf"), null, url);
});

test("spellings the URL parser already normalizes come back canonical, so the unique index still catches them", () => {
  assert.equal(canonicalBlobUrl(`https://${host}:443/files/./a.pdf`, "files/a.pdf"), `https://${host}/files/a.pdf`);
});

test("a URL outside Blob, outside files/, or not matching the pathname is refused", () => {
  assert.equal(canonicalBlobUrl("https://evil.example.com/files/a.pdf", "files/a.pdf"), null);
  assert.equal(canonicalBlobUrl(`https://${host}/brand/logo.png`, "brand/logo.png"), null);
  assert.equal(canonicalBlobUrl(`https://${host}/files/other.pdf`, "files/a.pdf"), null);
  assert.equal(canonicalBlobUrl(`https://${host}/files/%E0%A4%A.pdf`, "files/a.pdf"), null);
  assert.equal(canonicalBlobUrl("not a url", "files/a.pdf"), null);
  // The same name spelled with a different encoding.
  assert.equal(canonicalBlobUrl(`https://${host}/files/%61.pdf`, "files/a.pdf"), null);
  assert.equal(canonicalBlobUrl(`https://${host}/files/Acme MSA.txt`, "files/Acme MSA.txt"), `https://${host}/files/Acme%20MSA.txt`);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { zipFitsUnder } from "./docx";

/** A one-entry zip whose entry is `content`, deflated. */
function zip(content: Buffer, name = "a.xml") {
  const data = deflateRawSync(content);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(1, 24); // understates the size, as a bomb would
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const dirAt = 30 + n.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(dirAt, 16);
  return new Uint8Array(Buffer.concat([local, n, data, central, n, end]));
}

test("a zip within the budget passes", async () => {
  assert.equal(await zipFitsUnder(zip(Buffer.from("hello")), 1000), true);
});

test("a zip that inflates past the budget fails, whatever its headers say", async () => {
  assert.equal(await zipFitsUnder(zip(Buffer.alloc(5_000_000)), 1_000_000), false);
});

test("something that isn't a zip fails", async () => {
  assert.equal(await zipFitsUnder(new Uint8Array([1, 2, 3]), 1000), false);
});

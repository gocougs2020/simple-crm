import assert from "node:assert/strict";
import { test } from "node:test";
import { readStateFor } from "./read-rules";

const sam = "sam";
const alex = "alex";

test("an owned conversation is unread only for its owner", () => {
  assert.deepEqual(readStateFor({ read: false, ownerId: sam }, sam), { unread: true, canChange: true, ownerId: sam });
  assert.deepEqual(readStateFor({ read: false, ownerId: sam }, alex), { unread: false, canChange: false, ownerId: sam });
});

test("a conversation nobody owns is unread for everyone, and anyone can read it", () => {
  assert.deepEqual(readStateFor({ read: false, ownerId: null }, sam), { unread: true, canChange: true, ownerId: null });
  assert.deepEqual(readStateFor({ read: false, ownerId: null }, alex), { unread: true, canChange: true, ownerId: null });
});

test("a read conversation is read for everyone", () => {
  assert.equal(readStateFor({ read: true, ownerId: sam }, sam).unread, false);
  assert.equal(readStateFor({ read: true, ownerId: null }, alex).unread, false);
});

test("the unread follows the record to a new owner", () => {
  const conversation = { read: false, ownerId: sam };
  assert.equal(readStateFor(conversation, alex).unread, false);
  conversation.ownerId = alex;
  assert.equal(readStateFor(conversation, alex).unread, true);
  assert.equal(readStateFor(conversation, sam).unread, false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { folderLabel, folderPath, folderTree } from "./folder-tree";

const folders = [
  { id: "b", name: "Contracts", parentId: null },
  { id: "a", name: "Brand", parentId: null },
  { id: "c", name: "2026", parentId: "b" },
  { id: "d", name: "Signed", parentId: "c" },
];

test("folderPath walks from the top level down", () => {
  assert.deepEqual(
    folderPath(folders, "d").map((f) => f.id),
    ["b", "c", "d"],
  );
  assert.deepEqual(folderPath(folders, null), []);
  assert.deepEqual(folderPath(folders, "missing"), []);
});

test("folderPath stops on a loop", () => {
  const loop = [
    { id: "x", name: "X", parentId: "y" },
    { id: "y", name: "Y", parentId: "x" },
  ];
  assert.equal(folderPath(loop, "x").length, 2);
});

test("folderTree lists folders by name with what's inside each", () => {
  assert.deepEqual(
    folderTree(folders).map((f) => [f.id, f.depth]),
    [
      ["a", 0],
      ["b", 0],
      ["c", 1],
      ["d", 2],
    ],
  );
});

test("folderTree can leave out a folder and everything in it", () => {
  assert.deepEqual(
    folderTree(folders, "c").map((f) => f.id),
    ["a", "b"],
  );
});

test("folderLabel names the path", () => {
  assert.equal(folderLabel(folders, "d"), "Contracts / 2026 / Signed");
  assert.equal(folderLabel(folders, null), "Top level");
});

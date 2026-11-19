/**
 * Walking the Files page's folders in the browser. Folders are few, so the page
 * gets them all as a flat list and works out paths and the tree from it. Pure,
 * so it can be tested.
 */

export type FolderNode = { id: string; name: string; parentId: string | null };

/** The folders from the top level down to `id`, inclusive. Stops on a missing parent or a loop. */
export function folderPath<T extends FolderNode>(folders: T[], id: string | null | undefined): T[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: T[] = [];
  const seen = new Set<string>();
  for (let at = id ? byId.get(id) : undefined; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    path.unshift(at);
  }
  return path;
}

/** Every folder in tree order (each folder, then what's inside it, by name), with its depth. `without` leaves out a folder and everything in it. */
export function folderTree<T extends FolderNode>(folders: T[], without?: string): (T & { depth: number })[] {
  const children = new Map<string | null, T[]>();
  for (const f of folders) children.set(f.parentId, [...(children.get(f.parentId) ?? []), f]);
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const out: (T & { depth: number })[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const f of children.get(parent) ?? []) {
      if (f.id === without || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** "Contracts / 2026", or "Top level". */
export function folderLabel(folders: FolderNode[], id: string | null | undefined) {
  const path = folderPath(folders, id);
  return path.length ? path.map((f) => f.name).join(" / ") : "Top level";
}

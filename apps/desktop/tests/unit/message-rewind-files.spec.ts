import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, link, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { TurnCheckpointStore } from "../../electron/workbench/checkpoint-store";
import {
  planRewindFiles,
  checkRewindFiles,
  restoreRewindFiles,
} from "../../electron/workbench/message-rewind-files";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-rewind-files-"));
  const checkout = join(directory, "checkout");
  await mkdir(checkout);
  await new Promise<void>((accept, reject) =>
    execFile("git", ["init", "--template=", checkout], (error) =>
      error ? reject(error) : accept(),
    ),
  );
  const store = new TurnCheckpointStore(join(directory, "data"), { timeoutMs: 10_000 });
  await writeFile(join(checkout, "changed.txt"), "original\n");
  await writeFile(join(checkout, "deleted.txt"), "deleted-original\n");
  await new Promise<void>((accept, reject) =>
    execFile("git", ["-C", checkout, "add", "."], (error) => (error ? reject(error) : accept())),
  );
  const before = await store.capture(checkout);
  await writeFile(join(checkout, "changed.txt"), "agent\n");
  await writeFile(join(checkout, "created.txt"), "new\n");
  // Model deletions without deleting a test artifact: move it outside the checkout.
  const { rename } = await import("node:fs/promises");
  await rename(join(checkout, "deleted.txt"), join(directory, "deleted-source.txt"));
  const after = await store.capture(checkout);
  if (before.state !== "available" || after.state !== "available") throw Error("Нет снимка");
  const files = await planRewindFiles(store.repositoryPath, before.treeOid, after.treeOid);
  return { directory, checkout, files };
}
test("restores modified, created and deleted files, retaining original copies", async () => {
  const { directory, checkout, files } = await fixture();
  expect(files).toHaveLength(3);
  const headBefore = await readFile(join(checkout, ".git", "HEAD"));
  const indexBefore = await readFile(join(checkout, ".git", "index"));
  await chmod(join(checkout, "changed.txt"), 0o600);
  const backup = await restoreRewindFiles(checkout, files, join(directory, "backups"));
  expect((await lstat(join(checkout, "changed.txt"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(checkout, "changed.txt"), "utf8")).toBe("original\n");
  expect(await readFile(join(checkout, "deleted.txt"), "utf8")).toBe("deleted-original\n");
  await expect(lstat(join(checkout, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(checkout, ".git", "HEAD"))).toEqual(headBefore);
  expect(await readFile(join(checkout, ".git", "index"))).toEqual(indexBefore);
  const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")) as {
    files: { path: string; copy: string | null }[];
  };
  const entry = manifest.files.find((file) => file.path === "changed.txt")!;
  expect(await readFile(join(backup, entry.copy!), "utf8")).toBe("agent\n");
});
test("blocks later human edits before touching any file", async () => {
  const { directory, checkout, files } = await fixture();
  await writeFile(join(checkout, "changed.txt"), "human\n");
  await expect(restoreRewindFiles(checkout, files, join(directory, "backups"))).rejects.toThrow(
    "более поздние изменения",
  );
  expect(await readFile(join(checkout, "created.txt"), "utf8")).toBe("new\n");
  expect(await readFile(join(checkout, "changed.txt"), "utf8")).toBe("human\n");
});
test("rejects symbolic links, hard links and stale plans", async () => {
  const { directory, checkout, files } = await fixture();
  const { rename } = await import("node:fs/promises");
  await rename(join(checkout, "changed.txt"), join(directory, "outside.txt"));
  await symlink(join(directory, "outside.txt"), join(checkout, "changed.txt"));
  await expect(checkRewindFiles(checkout, files)).rejects.toThrow("изменился");
  await rename(join(checkout, "changed.txt"), join(directory, "symlink"));
  await link(join(directory, "outside.txt"), join(checkout, "changed.txt"));
  await expect(checkRewindFiles(checkout, files)).rejects.toThrow("изменился");
  expect(await readFile(join(directory, "outside.txt"), "utf8")).toBe("agent\n");
});

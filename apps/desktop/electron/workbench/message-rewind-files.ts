import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isolatedGitEnvironment } from "../platform/files/git-environment";

interface TreeFile {
  readonly mode: string;
  readonly oid: string;
}
export interface RewindFile {
  readonly path: string;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
  readonly beforeMode: number;
  readonly afterMode: number;
}

async function git(repository: string, args: string[]): Promise<Buffer> {
  return new Promise((accept, reject) => {
    execFile(
      "git",
      ["--git-dir", repository, ...args],
      {
        env: isolatedGitEnvironment(),
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout) => (error ? reject(error) : accept(stdout)),
    );
  });
}
async function tree(repository: string, oid: string): Promise<Map<string, TreeFile>> {
  const result = new Map<string, TreeFile>();
  for (const entry of (await git(repository, ["ls-tree", "-rz", oid]))
    .toString("utf8")
    .split("\0")) {
    if (!entry) continue;
    const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Снимок содержит неподдерживаемый тип файла.");
    result.set(match[3]!, { mode: match[1]!, oid: match[2]! });
  }
  return result;
}
export async function planRewindFiles(
  repository: string,
  beforeTree: string,
  afterTree: string,
): Promise<readonly RewindFile[]> {
  const [before, after] = await Promise.all([
    tree(repository, beforeTree),
    tree(repository, afterTree),
  ]);
  const result: RewindFile[] = [];
  let bytes = 0;
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(path),
      right = after.get(path);
    if (left?.oid === right?.oid && left?.mode === right?.mode) continue;
    if ([left, right].some((entry) => entry && !["100644", "100755"].includes(entry.mode))) {
      throw new Error("Откат символьных ссылок и специальных файлов недоступен.");
    }
    const oldBytes = left ? await git(repository, ["cat-file", "blob", left.oid]) : null;
    const newBytes = right ? await git(repository, ["cat-file", "blob", right.oid]) : null;
    bytes += (oldBytes?.length ?? 0) + (newBytes?.length ?? 0);
    if (bytes > 64 * 1024 * 1024 || result.length >= 2000)
      throw new Error("Слишком большой объём отката.");
    result.push({
      path,
      before: oldBytes,
      after: newBytes,
      beforeMode: left?.mode === "100755" ? 0o755 : 0o644,
      afterMode: right?.mode === "100755" ? 0o755 : 0o644,
    });
  }
  return result;
}

async function safePath(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  if (
    !absolute.startsWith(root + sep) ||
    path.split(/[\\/]/).some((part) => part === ".git" || part === "..")
  ) {
    throw new Error("Недопустимый путь в снимке.");
  }
  let parent = dirname(absolute);
  while (parent !== root) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Папка изменилась: ${path}`);
    parent = dirname(parent);
  }
  return absolute;
}

export async function checkRewindFiles(
  checkout: string,
  files: readonly RewindFile[],
): Promise<void> {
  const root = await realpath(checkout);
  for (const file of files) {
    const absolute = await safePath(root, file.path);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (file.after === null) {
      if (info) throw new Error(`После ответа появился файл ${file.path}. Откат заблокирован.`);
      continue;
    }
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (info.mode & 0o111) !== (file.afterMode & 0o111)
    ) {
      throw new Error(`Файл ${file.path} изменился после ответа. Откат заблокирован.`);
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.readFile()).equals(file.after))
        throw new Error(`В файле ${file.path} есть более поздние изменения. Откат заблокирован.`);
    } finally {
      await handle.close();
    }
  }
}

/** Backups survive both success and failure. No Git index, HEAD or refs in the checkout are changed. */
export async function restoreRewindFiles(
  checkout: string,
  files: readonly RewindFile[],
  backupRoot: string,
): Promise<string> {
  const root = await realpath(checkout);
  await checkRewindFiles(root, files);
  const backup = join(backupRoot, randomUUID());
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const manifest = files.map((file, index) => ({
    path: file.path,
    copy: file.after === null ? null : String(index),
    mode: file.afterMode,
  }));
  for (const [index, file] of files.entries()) {
    if (file.after)
      await writeFile(join(backup, String(index)), file.after, { flag: "wx", mode: 0o600 });
  }
  await writeFile(
    join(backup, "manifest.json"),
    JSON.stringify({ checkout: root, files: manifest }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  await checkRewindFiles(root, files);
  const applied: string[] = [];
  try {
    for (const file of files) {
      // Revalidate each path immediately before touching it, not only at dialog-open time.
      await checkRewindFiles(root, [file]);
      const absolute = await safePath(root, file.path);
      if (file.before === null) {
        // A newly created file is moved, never irreversibly deleted.
        await rename(absolute, join(backup, `removed-${applied.length}`));
      } else if (file.after === null) {
        await writeFile(absolute, file.before, { flag: "wx", mode: file.beforeMode & 0o700 });
      } else {
        const handle = await open(absolute, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (info.nlink !== 1 || !(await handle.readFile()).equals(file.after))
            throw new Error(`Файл изменился: ${file.path}`);
          await handle.truncate(0);
          let offset = 0;
          while (offset < file.before.length) {
            const { bytesWritten } = await handle.write(
              file.before,
              offset,
              file.before.length - offset,
              offset,
            );
            if (!bytesWritten) throw new Error(`Не удалось полностью записать файл ${file.path}`);
            offset += bytesWritten;
          }
          await handle.chmod((info.mode & 0o666) | (file.beforeMode & 0o111));
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      applied.push(file.path);
    }
    await writeFile(join(backup, "result.json"), JSON.stringify({ applied }), { mode: 0o600 });
    return backup;
  } catch (error) {
    await writeFile(
      join(backup, "result.json"),
      JSON.stringify({ applied, error: String(error) }),
      { mode: 0o600 },
    );
    throw new Error(
      `Откат прерван. Уже обработаны: ${applied.join(", ") || "нет"}. Резервные копии: ${backup}. ${String(error)}`,
    );
  }
}

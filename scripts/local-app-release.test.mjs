import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectProblems,
  mainTreeProblems,
  nextVersion,
  parseWorktrees,
  versionTag,
} from "./local-app-release.mjs";

function run(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repoWithCommit() {
  const root = mkdtempSync(join(tmpdir(), "pi-app-release-"));
  const repo = join(root, "pi-gui");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "file.txt"), "first\n");
  run(repo, "add", ".");
  run(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "first");
  return { root, repo };
}

test("parseWorktrees читает путь, ветку и служебные строки", () => {
  const text = [
    "worktree /Users/x/Space/pi-gui",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /Users/x/Space/pi-gui-feature",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/feature/x",
    "",
    "worktree /Users/x/Space/detached",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    "",
  ].join("\n");

  assert.deepEqual(parseWorktrees(text), [
    {
      path: "/Users/x/Space/pi-gui",
      branch: "main",
      head: "1111111111111111111111111111111111111111",
      bare: false,
    },
    {
      path: "/Users/x/Space/pi-gui-feature",
      branch: "feature/x",
      head: "2222222222222222222222222222222222222222",
      bare: false,
    },
    {
      path: "/Users/x/Space/detached",
      branch: "",
      head: "3333333333333333333333333333333333333333",
      bare: false,
    },
  ]);
});

test("nextVersion поднимает патч от старшего тега и игнорирует чужие теги", () => {
  assert.equal(nextVersion([]), "0.0.1");
  assert.equal(nextVersion(["v1.0.1"]), "1.0.2");
  assert.equal(nextVersion(["v1.0.1", "v1.0.9", "v1.2.0", "v1.10.0"]), "1.10.1");
  assert.equal(nextVersion(["v1.0.1", "local-20261111-1", "nightly"]), "1.0.2");
  assert.equal(versionTag("1.0.2"), "v1.0.2");
});

test("чистый main без других деревьев проходит проверку", () => {
  const { root, repo } = repoWithCommit();
  try {
    assert.deepEqual(mainTreeProblems(repo), []);
    assert.deepEqual(collectProblems(repo), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("незакоммиченные файлы и чужая ветка в основном дереве ловятся", () => {
  const { root, repo } = repoWithCommit();
  try {
    writeFileSync(join(repo, "file.txt"), "changed\n");
    assert.match(mainTreeProblems(repo).join("\n"), /незакоммиченных изменений/);

    run(repo, "stash", "-q");
    run(repo, "checkout", "-q", "-b", "feature/manual");
    assert.match(mainTreeProblems(repo).join("\n"), /нужна main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("коммиты вне main ловятся и без рабочего дерева", () => {
  const { root, repo } = repoWithCommit();
  try {
    run(repo, "checkout", "-q", "-b", "feature/z");
    writeFileSync(join(repo, "z.txt"), "z\n");
    run(repo, "add", ".");
    run(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "z");
    run(repo, "checkout", "-q", "main");

    assert.match(collectProblems(repo).join("\n"), /ветка feature\/z держит 1 коммитов/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("рабочее дерево на main тоже блокирует выкатку", () => {
  const { root, repo } = repoWithCommit();
  const worktree = join(root, "pi-gui-side");
  try {
    run(repo, "worktree", "add", "-q", "-b", "feature/side", worktree, "main");
    const problems = collectProblems(repo).join("\n");
    assert.match(problems, /дерево .*pi-gui-side на ветке feature\/side/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

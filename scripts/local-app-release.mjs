#!/usr/bin/env node
/*
 * Локальный цикл работы над приложением: одно дерево, одна ветка main, тег на выкатку.
 *
 * Работа над приложением идёт в отдельном рабочем дереве (worktree), main в основном
 * дереве остаётся чистым и только принимает слияния. Выкатка возможна только из main
 * основного дерева, когда других деревьев и неслтых веток нет: иначе в собранный пакет
 * попадает случайный набор изменений, и часть работы пропадает из приложения.
 *
 *   node scripts/local-app-release.mjs check
 *   node scripts/local-app-release.mjs worktree расход-в-приложении
 *   node scripts/local-app-release.mjs merge
 *   node scripts/local-app-release.mjs release
 *
 * Версия идёт по semver: тег v1.0.2, следующая выкатка поднимает патч, манифест
 * apps/desktop/package.json получает ту же версию, её же показывает раздел About.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = resolve(HERE, "..");
export const WORKTREE_BASE = join(homedir(), "Space", "pi-gui");
export const MAIN_BRANCH = "main";

/** Запуск git в каталоге репозитория, с понятной ошибкой вместо стека. */
export function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function gitOrNull(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return undefined;
  }
}

/** Разбор вывода `git worktree list --porcelain`: путь, ветка, служебные флаги. */
export function parseWorktrees(text) {
  const worktrees = [];
  let current;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: "", head: "", bare: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "bare") current.bare = true;
    else if (line === "detached") current.branch = "";
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/** Сколько коммитов ветки нет в main. Основное дерево на main даёт 0. */
export function commitsAhead(repo, branch, mainBranch = MAIN_BRANCH) {
  if (!branch) return 0;
  const value = gitOrNull(repo, ["rev-list", "--count", `${mainBranch}..${branch}`]);
  return value === undefined ? 0 : Number(value.trim());
}

function dirtyCount(repo) {
  const value = gitOrNull(repo, ["status", "--porcelain", "--untracked-files=all"]);
  return value === undefined ? 0 : value.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Состояние одного дерева для отчёта: ветка, грязь, неслlитые коммиты. */
export function describeWorktree(repo, worktree, mainBranch = MAIN_BRANCH) {
  return {
    path: worktree.path,
    branch: worktree.branch,
    dirty: dirtyCount(worktree.path),
    ahead: commitsAhead(repo, worktree.branch, mainBranch),
  };
}

/** Сравнение путей через realpath: /var и /private/var это один каталог. */
function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

/** Все деревья репозитория с состоянием, main отделён от рабочих. */
export function describeRepository(repo, mainBranch = MAIN_BRANCH) {
  const worktrees = parseWorktrees(git(repo, ["worktree", "list", "--porcelain"]));
  const described = worktrees.map((worktree) => ({
    ...describeWorktree(repo, worktree, mainBranch),
    isMain: samePath(worktree.path, repo),
  }));
  return {
    all: described,
    main: described.find((item) => item.isMain),
    others: described.filter((item) => !item.isMain),
  };
}

/** Нарушения только по основному дереву: это чистая ветка main, не рабочее дерево. */
export function mainTreeProblems(repo, mainBranch = MAIN_BRANCH) {
  const problems = [];
  if (!existsSync(join(repo, ".git"))) {
    return [`каталог не похож на основной репозиторий: ${repo}`];
  }
  const gitDir = (gitOrNull(repo, ["rev-parse", "--git-dir"]) ?? "").trim();
  if (gitDir.includes("worktrees")) {
    problems.push(`${repo} это рабочее дерево (${gitDir}), работа идёт только из основного`);
  }
  const branch = (gitOrNull(repo, ["branch", "--show-current"]) ?? "").trim();
  if (branch !== mainBranch) {
    problems.push(`основное дерево на ветке ${branch || "detached"}, нужна ${mainBranch}`);
  }
  const dirty = dirtyCount(repo);
  if (dirty > 0) problems.push(`в основном дереве ${dirty} незакоммиченных изменений`);
  return problems;
}

/**
 * Проверка «можно выкатывать»: основное дерево на main и без изменений, других деревьев нет,
 * ни одна ветка не держит коммитов, которых нет в main. Возвращает список нарушений.
 */
export function collectProblems(repo, options = {}) {
  const mainBranch = options.mainBranch ?? MAIN_BRANCH;
  const problems = [...mainTreeProblems(repo, mainBranch)];
  if (problems.some((problem) => problem.includes("не похож"))) return problems;

  const state = describeRepository(repo, mainBranch);
  for (const other of state.others) {
    const parts = [`дерево ${other.path} на ветке ${other.branch || "detached"}`];
    if (other.dirty > 0) parts.push(`${other.dirty} незакоммиченных изменений`);
    if (other.ahead > 0) parts.push(`${other.ahead} коммитов не в ${mainBranch}`);
    problems.push(`${parts.join(", ")}: сначала make app-merge`);
  }

  const unmerged = (gitOrNull(repo, ["branch", "--no-merged", mainBranch, "--format=%(refname:short)"]) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const branch of unmerged) {
    const ahead = commitsAhead(repo, branch, mainBranch);
    problems.push(`ветка ${branch} держит ${ahead} коммитов, которых нет в ${mainBranch}`);
  }
  return problems;
}

/**
 * Следующая версия по правилам semver: от старшего тега vX.Y.Z поднимаем патч.
 * Теги другого вида (например local-*) не учитываются, чтобы не сбивать нумерацию.
 */
export function nextVersion(existingTags) {
  let best = [0, 0, 0];
  for (const tag of existingTags) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    const newer =
      parts[0] > best[0] ||
      (parts[0] === best[0] && parts[1] > best[1]) ||
      (parts[0] === best[0] && parts[1] === best[1] && parts[2] > best[2]);
    if (newer) best = parts;
  }
  return `${best[0]}.${best[1]}.${best[2] + 1}`;
}

/** Версия в манифесте приложения и в теге: 1.0.2 и v1.0.2. */
export function versionTag(version) {
  return `v${version}`;
}

function report(state) {
  const lines = [];
  const describe = (item) => {
    const branch = item.branch || "detached";
    const dirty = item.dirty > 0 ? `${item.dirty} изменений` : "чисто";
    const ahead = item.ahead > 0 ? `${item.ahead} не в main` : "всё в main";
    return `  ${item.path}\n    ветка ${branch}, ${dirty}, ${ahead}`;
  };
  if (state.main) lines.push("Основное дерево:", describe(state.main));
  if (state.others.length === 0) lines.push("Других рабочих деревьев нет.");
  else lines.push("Другие деревья:", ...state.others.map(describe));
  return lines.join("\n");
}

function requireRepo(input) {
  const repo = resolve(input || process.env.PI_GUI_REPO || DEFAULT_REPO);
  const real = existsSync(repo) ? realpathSync(repo) : repo;
  if (!existsSync(join(real, "apps", "desktop"))) {
    throw new Error(`не нашёл приложение в ${repo}`);
  }
  return real;
}

function slugBranch(slug) {
  const clean = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/, "");
  if (clean.length === 0) throw new Error("нужно имя задачи: make app-worktree NAME=<короткое имя>");
  return clean;
}

function commandCheck(repo) {
  const state = describeRepository(repo);
  console.log(report(state));
  const problems = collectProblems(repo);
  if (problems.length === 0) {
    console.log("\nМожно выкатывать: основное дерево на main, других деревьев нет.");
    return 0;
  }
  console.error("\nВыкатывать нельзя:");
  for (const problem of problems) console.error(`  - ${problem}`);
  return 1;
}

function commandWorktree(repo, slug) {
  const branch = `feature/${slugBranch(slug)}`;
  const path = `${WORKTREE_BASE}-${slugBranch(slug)}`;

  const problems = mainTreeProblems(repo);
  if (problems.length > 0) {
    console.error("Сначала приведи основное дерево в порядок:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  if (existsSync(path)) {
    console.error(`Каталог уже существует: ${path}`);
    return 1;
  }
  git(repo, ["worktree", "add", "-b", branch, path, MAIN_BRANCH], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`Готово: ${path} на ветке ${branch}`);
  console.log("\nДальше:");
  console.log(`  cd ${path} && pnpm install --frozen-lockfile`);
  console.log("  работа и коммиты здесь, затем make app-merge и make app-release");
  return 0;
}

function commandMerge(repo) {
  const state = describeRepository(repo);
  const main = state.main;
  if (!main || main.branch !== MAIN_BRANCH) {
    console.error(`Слияние делается из основного дерева на ветке ${MAIN_BRANCH}`);
    return 1;
  }
  if (main.dirty > 0) {
    console.error(`В основном дереве ${main.dirty} незакоммиченных изменений, сначала закоммить их`);
    return 1;
  }
  if (state.others.length === 0) {
    console.log("Других деревьев нет, сливать нечего.");
    return 0;
  }
  const dirty = state.others.filter((other) => other.dirty > 0);
  if (dirty.length > 0) {
    console.error("В этих деревьях незакоммиченная работа, сначала закоммить её там:");
    for (const other of dirty) console.error(`  - ${other.path}: ${other.dirty} файлов`);
    return 1;
  }

  let failures = 0;
  for (const other of state.others) {
    if (!other.branch || other.ahead === 0) {
      console.log(`Пропускаю ${other.path}: коммитов сверх ${MAIN_BRANCH} нет`);
      continue;
    }
    console.log(`Сливаю ${other.branch} (${other.ahead} коммитов) из ${other.path}`);
    try {
      git(repo, ["merge", "--no-ff", other.branch, "-m", `Влить ${other.branch}`], {
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch {
      failures += 1;
      console.error(`\nКонфликт в ${other.branch}. Разрешай файлы в ${repo}, затем:`);
      console.error("  git add -A && git commit --no-edit && make app-merge");
      break;
    }
  }
  if (failures > 0) return 1;
  console.log("\nСлияния готовы, проверь типы и тесты, затем make app-release");
  return 0;
}

/** Версия в манифесте приложения: по ней же electron-builder ставит версию пакета. */
function writeAppVersion(repo, version) {
  const path = join(repo, "apps", "desktop", "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function tagExists(repo, tag) {
  return (gitOrNull(repo, ["tag", "--list", tag]) ?? "").trim().length > 0;
}

function commandRelease(repo, args) {
  const problems = collectProblems(repo);
  if (problems.length > 0) {
    console.error("Выкатывать нельзя:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  const tags = (gitOrNull(repo, ["tag", "--list"]) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const version = args.version || nextVersion(tags);
  const tag = versionTag(version);
  if (tagExists(repo, tag)) {
    console.error(`Тег ${tag} уже есть`);
    return 1;
  }

  const installScript = args.installScript;
  console.log(`Версия ${version}: поднимаю манифест и коммичу, затем сборка из main`);
  writeAppVersion(repo, version);
  git(repo, ["add", "apps/desktop/package.json"], { stdio: ["ignore", "inherit", "inherit"] });
  git(repo, ["commit", "-q", "-m", `Версия ${version}`], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`Собираю ${tag} из main (${(gitOrNull(repo, ["rev-parse", "--short", "HEAD"]) ?? "").trim()})`);
  if (!args.skipBuild) {
    execFileSync("bash", [installScript], {
      cwd: repo,
      stdio: "inherit",
      env: { ...process.env, PI_GUI_REPO: repo, PI_APP_VERSION: version },
    });
  }
  const installed = args.app ?? "/Applications/pi-gui.app";
  const asar = join(installed, "Contents", "Resources", "app.asar");
  if (!args.skipBuild) {
    const found = Number(
      (execFileSync("grep", ["-a", "-c", "-F", version, asar], { encoding: "utf8" }) || "0").trim(),
    );
    if (found === 0) {
      console.error(`\nВ установленном пакете нет версии ${version}: сборка прошла без PI_APP_VERSION`);
      return 1;
    }
  }
  git(repo, ["tag", "-a", tag, "-m", `Выкатка ${tag}`], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`\nТег ${tag} поставлен, версия ${version} видна в настройках, раздел About.`);
  console.log(`Откат: bash ${join(homedir(), ".pi", "agent", "skills", "pi-gui-install", "scripts", "restore.sh")}`);
  return 0;
}

function usage() {
  console.log(`Использование: node scripts/local-app-release.mjs <команда>

  check                     состояние деревьев и веток, можно ли выкатывать
  worktree NAME             новое рабочее дерево ${WORKTREE_BASE}-NAME на feature/NAME
  merge                     слить ветки рабочих деревьев в main
  release [--version X.Y.Z] проверка, версия, сборка, установка и тег vX.Y.Z
  release --skip-build      только версия и тег, без сборки`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) continue;
    const name = value.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  const positional = rest.filter((value) => !value.startsWith("--"));
  const repo = requireRepo(flags.repo);

  switch (command) {
    case "check":
      return commandCheck(repo);
    case "worktree":
      return commandWorktree(repo, positional[0] ?? "");
    case "merge":
      return commandMerge(repo);
    case "release": {
      const installScript =
        typeof flags.install === "string"
          ? flags.install
          : join(homedir(), ".pi", "agent", "skills", "pi-gui-install", "scripts", "install.sh");
      return commandRelease(repo, {
        version: typeof flags.version === "string" ? flags.version : undefined,
        skipBuild: flags["skip-build"] === true,
        installScript,
      });
    }
    case undefined:
    case "-h":
    case "--help":
      usage();
      return 0;
    default:
      console.error(`Неизвестная команда: ${command}`);
      usage();
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

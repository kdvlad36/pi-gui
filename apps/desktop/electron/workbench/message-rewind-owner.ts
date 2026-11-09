import { randomUUID } from "node:crypto";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  MessageRewindInput,
  MessageRewindPlan,
  MessageRewindResult,
} from "../../contracts/message-rewind";
import type { DesktopAppStore } from "../application/app-store";
import type { TurnCheckpointStore } from "./checkpoint-store";
import {
  checkRewindFiles,
  planRewindFiles,
  restoreRewindFiles,
  type RewindFile,
} from "./message-rewind-files";

interface OwnedPlan {
  readonly input: MessageRewindInput;
  readonly leafId: string | null;
  readonly expires: number;
  readonly checkout: string;
  readonly files: readonly RewindFile[];
  readonly public: MessageRewindPlan;
}
export class MessageRewindOwner {
  private readonly plans = new Map<string, OwnedPlan>();
  constructor(
    private readonly host: Pick<
      DesktopAppStore,
      | "validateMessageRewind"
      | "getSessionTree"
      | "navigateSessionTree"
      | "getWorkspacePath"
      | "updateComposerDraft"
    >,
    private readonly checkpoints: TurnCheckpointStore,
    private readonly userDataDir: string,
  ) {}

  async prepare(input: MessageRewindInput): Promise<MessageRewindPlan> {
    const resolved = await this.host.validateMessageRewind(input.target, input.messageId);
    input = { ...input, messageId: resolved.messageId };
    const tree = await this.host.getSessionTree(input.target);
    const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
    const branch: string[] = [];
    let cursor = tree.leafId;
    while (cursor && !branch.includes(cursor)) {
      branch.push(cursor);
      cursor = nodes.get(cursor)?.parentId ?? null;
    }
    branch.reverse();
    const index = branch.indexOf(input.messageId);
    if (index < 0 || nodes.get(input.messageId)?.role !== "user")
      throw new Error("Сообщение больше не входит в текущую ветку.");
    const workspacePath = this.host.getWorkspacePath(input.target.workspaceId);
    if (!workspacePath) throw new Error("Папка проекта недоступна.");
    const checkout = await realpath(workspacePath);
    const records = await this.checkpoints.list(input.target);
    const first = records.find((record) => record.userEntryIds.includes(input.messageId));
    const range = branch.slice(index);
    const turns = records.filter((record) => record.userEntryIds.some((id) => range.includes(id)));
    const last = [...turns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    let files: readonly RewindFile[] = [];
    let warning: string | undefined;
    let restoreBlocked: string | undefined;
    const coverageComplete =
      first &&
      last &&
      first.before.state === "available" &&
      last.after?.state === "available" &&
      turns.every(
        (record) =>
          record.checkoutPath === checkout &&
          record.outcome !== "open" &&
          record.overlaps.length === 0 &&
          record.before.state === "available" &&
          record.before.coverage.state === "complete" &&
          record.after?.state === "available" &&
          record.after.coverage.state === "complete",
      ) &&
      range
        .filter((id) => ["user", "assistant"].includes(nodes.get(id)?.role ?? ""))
        .every((id) =>
          turns.some((record) =>
            [...record.userEntryIds, ...record.assistantEntryIds].includes(id),
          ),
        );
    if (
      !coverageComplete ||
      first.before.state !== "available" ||
      last.after?.state !== "available"
    ) {
      warning =
        "Не удалось проверить все изменения файлов. Можно вернуть сообщение без отката файлов.";
    } else {
      try {
        files = await planRewindFiles(
          this.checkpoints.repositoryPath,
          first.before.treeOid,
          last.after.treeOid,
        );
        try {
          await checkRewindFiles(checkout, files);
        } catch (error) {
          restoreBlocked = String(error);
        }
      } catch {
        warning = "Не удалось подготовить безопасный откат файлов. Можно вернуть только сообщение.";
      }
    }
    const plan: MessageRewindPlan = {
      id: randomUUID(),
      fileCount: files.length,
      ...(warning ? { warning } : {}),
      ...(restoreBlocked ? { restoreBlocked } : {}),
    };
    for (const [id, value] of this.plans) if (value.expires < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.id, {
      input: structuredClone(input),
      leafId: tree.leafId,
      expires: Date.now() + 10 * 60_000,
      checkout,
      files,
      public: plan,
    });
    return plan;
  }

  async apply(id: string, restore: boolean): Promise<MessageRewindResult> {
    const plan = this.plans.get(id);
    if (!plan || plan.expires < Date.now())
      throw new Error("План устарел. Нажми кнопку возврата ещё раз.");
    this.plans.delete(id); // No duplicate application or replay after partial failure.
    const original = await this.host.validateMessageRewind(plan.input.target, plan.input.messageId);
    const tree = await this.host.getSessionTree(plan.input.target);
    if (tree.leafId !== plan.leafId)
      throw new Error("Диалог изменился. Повтори возврат сообщения.");
    const workspacePath = this.host.getWorkspacePath(plan.input.target.workspaceId);
    if (!workspacePath || (await realpath(workspacePath)) !== plan.checkout)
      throw new Error("Папка проекта изменилась.");
    if (restore && (plan.public.warning || plan.public.restoreBlocked))
      throw new Error("Безопасный откат файлов недоступен.");
    let backupPath: string | undefined;
    let draftBackupPath: string | undefined;
    if (original.draft) {
      const drafts = join(this.userDataDir, "message-rewind-backups", "drafts");
      await mkdir(drafts, { recursive: true, mode: 0o700 });
      draftBackupPath = join(drafts, `${randomUUID()}.json`);
      await writeFile(
        draftBackupPath,
        JSON.stringify({ target: plan.input.target, text: original.draft }),
        { flag: "wx", mode: 0o600 },
      );
    }
    if (restore && plan.files.length)
      backupPath = await restoreRewindFiles(
        plan.checkout,
        plan.files,
        join(this.userDataDir, "message-rewind-backups", "files"),
      );
    let filesRestored = Boolean(restore && plan.files.length);
    try {
      const result = await this.host.navigateSessionTree(plan.input.target, plan.input.messageId, {
        summarize: false,
      });
      if (result.result.cancelled || result.result.aborted) {
        if (filesRestored) {
          await restoreRewindFiles(
            plan.checkout,
            plan.files.map((file) => ({
              ...file,
              before: file.after,
              after: file.before,
              beforeMode: file.afterMode,
              afterMode: file.beforeMode,
            })),
            join(this.userDataDir, "message-rewind-backups", "cancelled"),
          );
          filesRestored = false;
        }
        throw new Error("Переход по истории отменён. Файлы оставлены в исходном состоянии.");
      }
      const state = await this.host.updateComposerDraft(plan.input.target, original.text);
      return {
        state,
        editorText: original.text,
        ...(backupPath ? { backupPath } : {}),
        ...(draftBackupPath ? { draftBackupPath } : {}),
      };
    } catch (error) {
      throw new Error(
        `${String(error)}${draftBackupPath ? ` Черновик сохранён: ${draftBackupPath}` : ""}${backupPath ? ` Сохранённые копии: ${backupPath}` : ""}${filesRestored ? " Файлы уже восстановлены; диалог мог остаться на прежнем месте." : ""}`,
      );
    }
  }
}

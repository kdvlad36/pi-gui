import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { DesktopAppState, WorkspaceSessionTarget } from "../../../contracts/desktop-state";
import type { MessageRewindPlan } from "../../../contracts/message-rewind";
import { applySnapshotIfNewer } from "../../app/desktop-app-state";
import { trapDialogFocus } from "../../ui/dialog-focus";

export const MessageRewindContext = createContext<((id: string) => void) | undefined>(undefined);

export function MessageRewindButton({ messageId }: { readonly messageId: string }) {
  const rewind = useContext(MessageRewindContext);
  return (
    <div className="timeline-item__actions timeline-item__actions--rewind">
      <button
        className="timeline-item__action timeline-item__rewind"
        type="button"
        aria-label="Вернуть в поле ввода"
        title={rewind ? "Вернуть в поле ввода" : "Доступно после завершения ответа"}
        disabled={!rewind}
        onClick={() => rewind?.(messageId)}
        data-testid="rewind-message"
      >
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m8 5-5 5 5 5M3 10h10a6 6 0 0 1 0 12" transform="translate(1 -2)" />
        </svg>
      </button>
    </div>
  );
}

export function useMessageRewind({
  api,
  target,
  sessionKey,
  running,
  composerDraft,
  setSnapshot,
  setComposerDraft,
  focusComposer,
}: {
  readonly api: PiDesktopApi | undefined;
  readonly target: WorkspaceSessionTarget | undefined;
  readonly sessionKey: string;
  readonly running: boolean;
  readonly composerDraft: string;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly focusComposer: () => void;
}) {
  const [dialog, setDialog] = useState<{
    plan?: MessageRewindPlan;
    error?: string;
    busy: boolean;
    notice?: string;
  } | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const currentKey = useRef(sessionKey);
  currentKey.current = sessionKey;
  useEffect(() => {
    generation.current++;
    setDialog(null);
    inFlight.current = false;
  }, [sessionKey]);
  const apply = useCallback(
    async (plan: MessageRewindPlan, restore: boolean, key: string) => {
      if (!api) return;
      setDialog((current) => ({ ...current, plan, busy: true }));
      try {
        const result = await api.applyMessageRewind(plan.id, restore);
        if (currentKey.current !== key) return;
        applySnapshotIfNewer(setSnapshot, result.state);
        setComposerDraft(result.editorText);
        const copies = [result.backupPath, result.draftBackupPath].filter(Boolean);
        if (copies.length)
          setDialog({ busy: false, notice: `Сохранены резервные копии: ${copies.join(", ")}` });
        else {
          setDialog(null);
          focusComposer();
        }
      } catch (error) {
        if (currentKey.current === key) setDialog({ busy: false, error: String(error) });
      } finally {
        if (currentKey.current === key) inFlight.current = false;
      }
    },
    [api, setSnapshot, setComposerDraft, focusComposer],
  );
  const rewind = useCallback(
    (messageId: string) => {
      if (!api || !target || running || inFlight.current) return;
      const key = sessionKey,
        token = ++generation.current;
      inFlight.current = true;
      setDialog({ busy: true });
      // Persist the actual visible draft before main saves a copy and replaces it.
      void api
        .updateComposerDraft(composerDraft, target)
        .then(() => api.prepareMessageRewind({ target, messageId }))
        .then(async (plan) => {
          if (currentKey.current !== key || generation.current !== token) return;
          if (plan.fileCount || plan.warning || plan.restoreBlocked) {
            setDialog({ plan, busy: false });
            inFlight.current = false;
          } else await apply(plan, false, key);
        })
        .catch((error: unknown) => {
          if (currentKey.current === key) {
            setDialog({ busy: false, error: String(error) });
            inFlight.current = false;
          }
        });
    },
    [api, target, running, sessionKey, composerDraft, apply],
  );
  const close = useCallback(() => {
    if (!dialog?.busy) {
      setDialog(null);
      focusComposer();
    }
  }, [dialog?.busy, focusComposer]);
  return {
    rewind: running ? undefined : rewind,
    layer: dialog ? (
      <MessageRewindDialog
        dialog={dialog}
        onClose={close}
        onApply={(restore) => {
          if (dialog.plan && !inFlight.current) {
            inFlight.current = true;
            void apply(dialog.plan, restore, sessionKey).catch((error: unknown) =>
              console.error("[rewind] apply failed", error),
            );
          }
        }}
      />
    ) : null,
  };
}

function MessageRewindDialog({
  dialog,
  onClose,
  onApply,
}: {
  readonly dialog: { plan?: MessageRewindPlan; error?: string; busy: boolean; notice?: string };
  readonly onClose: () => void;
  readonly onApply: (restore: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [dialog.busy, dialog.notice, dialog.error, dialog.plan]);
  const plan = dialog.plan;
  return (
    <div className="tree-modal-backdrop">
      <div
        ref={ref}
        className="tree-modal tree-modal--compact message-rewind-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewind-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Tab") trapDialogFocus(event, ref.current);
          if (event.key === "Escape" && !dialog.busy) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="tree-modal__header">
          <h2 className="tree-modal__title" id="rewind-title">
            {dialog.busy
              ? "Возвращаем сообщение…"
              : dialog.notice
                ? "Сообщение возвращено"
                : dialog.error
                  ? "Не удалось вернуть сообщение"
                  : plan?.fileCount
                    ? "Откатить изменения в файлах?"
                    : "История файлов недоступна"}
          </h2>
          <button
            className="tree-modal__close"
            type="button"
            aria-label="Отмена"
            disabled={dialog.busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="tree-modal__summary-step">
          <div className="tree-modal__summary-copy" role="status">
            {dialog.error ??
              dialog.notice ??
              plan?.warning ??
              (plan
                ? `После этого сообщения изменены файлы: ${plan.fileCount}. Сообщение вернётся в поле ввода при любом выборе.`
                : "Проверяем историю и изменения файлов.")}
          </div>
          {plan?.restoreBlocked ? <p className="tree-modal__error">{plan.restoreBlocked}</p> : null}
          <div className="tree-modal__actions">
            {!dialog.busy && (dialog.error || dialog.notice) ? (
              <button className="button" type="button" onClick={onClose}>
                Закрыть
              </button>
            ) : null}
            {!dialog.busy && plan && !dialog.error ? (
              <>
                <button className="button" type="button" onClick={() => onApply(false)}>
                  {plan.fileCount ? "Оставить" : "Вернуть сообщение"}
                </button>
                {plan.fileCount ? (
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={Boolean(plan.warning || plan.restoreBlocked)}
                    onClick={() => onApply(true)}
                  >
                    Откатить
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/*
 * Локальная версия сборки. Тег выкатки приходит из scripts/local-app-release.mjs
 * через `PI_APP_VERSION` и подставляется в сборку через define в electron.vite.config.mjs.
 * В режиме разработки переменной нет, и окно показывает, что это dev-сборка.
 */
declare const __PI_APP_VERSION__: string | undefined;

export const APP_VERSION = typeof __PI_APP_VERSION__ === "string" ? __PI_APP_VERSION__ : "";

/** Что показать в настройках: тег выкатки или пометку о сборке для разработки. */
export function appVersionLabel(version = APP_VERSION): string {
  return version.trim().length > 0 ? version : "dev build";
}

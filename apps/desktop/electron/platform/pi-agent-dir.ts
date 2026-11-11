import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi's global agent directory in the main process, matching the runtime's own
 * resolution (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). Resolved locally
 * because the runtime package is ESM-only and cannot be required from the CJS
 * Electron main bundle.
 */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (!override) return join(homedir(), ".pi", "agent");
  return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
}

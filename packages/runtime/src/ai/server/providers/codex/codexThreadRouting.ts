import fs from 'fs';
import path from 'path';
import { CODEX_OPENAI_MODEL_PROVIDER } from './codexConfigModels';

/**
 * The part of a Codex route that a persisted thread's history is bound to.
 *
 * Providers persist provider-specific items (e.g. a third-party Responses
 * provider's `reasoning` items with `reasoning_text` content) into the thread
 * rollout, and another provider rejects that history on `thread/resume`.
 * Model and effort changes within one provider/profile stay resumable.
 */
export interface CodexThreadRouting {
  provider: string;
  profile: string | null;
}

export interface CodexThreadRoutingStore {
  get(threadId: string): CodexThreadRouting | undefined;
  set(threadId: string, routing: CodexThreadRouting): void;
}

export function codexThreadRoutingOf(route: {
  provider: string | null;
  profile: string | null;
}): CodexThreadRouting {
  return {
    provider: route.provider ?? CODEX_OPENAI_MODEL_PROVIDER,
    profile: route.profile ?? null,
  };
}

export function isSameCodexThreadRouting(a: CodexThreadRouting, b: CodexThreadRouting): boolean {
  return a.provider === b.provider && a.profile === b.profile;
}

export function createMemoryCodexThreadRoutingStore(): CodexThreadRoutingStore {
  const entries = new Map<string, CodexThreadRouting>();
  return {
    get: (threadId) => entries.get(threadId),
    set: (threadId, routing) => { entries.set(threadId, routing); },
  };
}

const MAX_FILE_ENTRIES = 5000;

/**
 * Thread-id-keyed routing records in a Nimbalyst-owned JSON file, so the
 * provider/profile a thread was created with survives app restarts. Codex's
 * own rollout files are never read or modified.
 */
export function createFileCodexThreadRoutingStore(filePath: string): CodexThreadRoutingStore {
  let entries: Map<string, CodexThreadRouting> | null = null;

  const load = (): Map<string, CodexThreadRouting> => {
    if (entries) return entries;
    entries = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      for (const [threadId, value] of Object.entries(parsed ?? {})) {
        const record = value as Partial<CodexThreadRouting> | null;
        if (record && typeof record.provider === 'string') {
          entries.set(threadId, {
            provider: record.provider,
            profile: typeof record.profile === 'string' ? record.profile : null,
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[CODEX] Could not read thread routing records:', error);
      }
    }
    return entries;
  };

  return {
    get: (threadId) => load().get(threadId),
    set: (threadId, routing) => {
      const current = load();
      current.delete(threadId);
      current.set(threadId, routing);
      while (current.size > MAX_FILE_ENTRIES) {
        current.delete(current.keys().next().value as string);
      }
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(current)));
        fs.renameSync(tmpPath, filePath);
      } catch (error) {
        console.warn('[CODEX] Could not persist thread routing records:', error);
      }
    },
  };
}

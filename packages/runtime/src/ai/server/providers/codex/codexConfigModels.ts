import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Model ids the user declared in Codex's own config.toml: the top-level
 * `model` and each `[profiles.<name>]` `model`. Codex's `model/list` only
 * reports OpenAI's catalog, so this is the one place a custom
 * `model_providers` model (e.g. a DeepSeek model) is declared. Only `model`
 * keys are read -- provider tables, tokens and everything else are ignored.
 */
export function parseCodexConfigModelIds(toml: string): string[] {
  const ids: string[] = [];
  let inModelTable = true; // keys before the first table header are top-level
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]*)\]/.exec(line);
    if (header) {
      inModelTable = /^\s*profiles\.("[^"]+"|'[^']+'|[\w-]+)\s*$/.test(header[1]);
      continue;
    }
    if (!inModelTable) {
      continue;
    }
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(line);
    const id = (match?.[1] ?? match?.[2])?.trim();
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/** Codex's config.toml, honoring `CODEX_HOME` the way the Codex CLI does. */
export async function readCodexConfigToml(): Promise<string | null> {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  try {
    return await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return null;
  }
}

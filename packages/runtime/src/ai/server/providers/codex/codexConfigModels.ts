import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/** Codex's built-in provider id for OpenAI's own models. */
export const CODEX_OPENAI_MODEL_PROVIDER = 'openai';

export interface CodexConfigModel {
  model: string;
  /** `model_provider` Codex would pair with this model, if config.toml sets one. */
  provider?: string;
}

/**
 * Models the user declared in Codex's own config.toml: the top-level `model`
 * and each `[profiles.<name>]` `model`, each with the `model_provider` Codex
 * would pair it with (a profile inherits the top-level one, as in Codex).
 * Codex's `model/list` only reports OpenAI's catalog, so this is the one place
 * a custom `model_providers` model (e.g. a DeepSeek model) is declared. Only
 * `model` and `model_provider` keys are read -- provider tables, tokens and
 * everything else are ignored.
 */
export function parseCodexConfigModels(toml: string): CodexConfigModel[] {
  const topLevel: { model?: string; provider?: string } = {};
  const profiles: Array<{ model?: string; provider?: string }> = [];
  let current: { model?: string; provider?: string } | null = topLevel; // keys before the first table header are top-level
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]*)\]/.exec(line);
    if (header) {
      current = /^\s*profiles\.("[^"]+"|'[^']+'|[\w-]+)\s*$/.test(header[1]) ? {} : null;
      if (current) {
        profiles.push(current);
      }
      continue;
    }
    if (!current) {
      continue;
    }
    const match = /^\s*(model|model_provider)\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(line);
    const value = (match?.[2] ?? match?.[3])?.trim();
    if (!match || !value) {
      continue;
    }
    if (match[1] === 'model') {
      current.model = value;
    } else {
      current.provider = value;
    }
  }

  const models: CodexConfigModel[] = [];
  for (const entry of [topLevel, ...profiles]) {
    const provider = entry.provider ?? topLevel.provider;
    if (entry.model && !models.some((existing) => existing.model === entry.model)) {
      models.push(provider ? { model: entry.model, provider } : { model: entry.model });
    }
  }
  return models;
}

export function parseCodexConfigModelIds(toml: string): string[] {
  return parseCodexConfigModels(toml).map((entry) => entry.model);
}

/**
 * The `model_provider` a Nimbalyst-selected model must run under, so it never
 * inherits an unrelated global `model_provider` from config.toml. A model the
 * config declares uses its declared provider; any other model is an OpenAI
 * catalog model and uses Codex's built-in `openai` provider. Returns undefined
 * when config.toml sets no provider at all, leaving Codex's default untouched.
 */
export function resolveCodexModelProvider(toml: string | null, model: string): string | undefined {
  if (!toml) {
    return undefined;
  }
  const models = parseCodexConfigModels(toml);
  const declared = models.find((entry) => entry.model === model)?.provider;
  if (declared) {
    return declared;
  }
  const configuresProvider = /^\s*model_provider\s*=/m.test(toml);
  return configuresProvider ? CODEX_OPENAI_MODEL_PROVIDER : undefined;
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

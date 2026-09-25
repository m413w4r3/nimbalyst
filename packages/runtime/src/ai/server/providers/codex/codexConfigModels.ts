import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isEffortLevel, type EffortLevel } from '../../effortLevels';

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

/** Codex's home directory, honoring `CODEX_HOME` the way the Codex CLI does. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/** Codex's config.toml, honoring `CODEX_HOME` the way the Codex CLI does. */
export async function readCodexConfigToml(): Promise<string | null> {
  try {
    return await fs.readFile(path.join(resolveCodexHome(), 'config.toml'), 'utf8');
  } catch {
    return null;
  }
}

/** Effort capabilities a custom model catalog declares for one model. */
export interface CodexModelEffortInfo {
  supportedEffortLevels: EffortLevel[];
  defaultEffortLevel?: EffortLevel;
}

/** Catalog effort capabilities keyed by model slug. */
export type CodexModelCatalog = Map<string, CodexModelEffortInfo>;

/**
 * Absolute path of the top-level `model_catalog_json` config.toml points at,
 * or null when it sets none. `~` expands to the home directory and a relative
 * path resolves against the Codex home, where config.toml lives.
 */
export function resolveCodexModelCatalogPath(
  toml: string,
  codexHome: string,
  homeDir: string = os.homedir(),
): string | null {
  let value: string | undefined;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      break; // only the top-level key counts, as in Codex
    }
    const match = /^\s*model_catalog_json\s*=\s*(?:"((?:[^"\\]|\\.)+)"|'([^']+)')/.exec(line);
    if (match) {
      value = match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : match[2];
    }
  }
  value = value?.trim();
  if (!value) {
    return null;
  }
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(homeDir, value.slice(1));
  }
  return path.resolve(codexHome, value);
}

/**
 * Parse a Codex model catalog (`{ models: [...] }`) down to each model's
 * declared effort levels. Only `slug`, `supported_reasoning_levels[].effort`
 * and `default_reasoning_level` are read; levels Nimbalyst has no name for are
 * dropped, and a model left with no known level gets no entry so it keeps the
 * static fallback. Malformed input yields an empty catalog.
 */
export function parseCodexModelCatalog(json: string): CodexModelCatalog {
  const catalog: CodexModelCatalog = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return catalog;
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    return catalog;
  }
  for (const entry of models) {
    const slug = (entry as { slug?: unknown } | null)?.slug;
    const levels = (entry as { supported_reasoning_levels?: unknown }).supported_reasoning_levels;
    if (typeof slug !== 'string' || !slug.trim() || !Array.isArray(levels)) {
      continue;
    }
    const supportedEffortLevels: EffortLevel[] = [];
    for (const level of levels) {
      const effort = (level as { effort?: unknown } | null)?.effort;
      if (isEffortLevel(effort) && !supportedEffortLevels.includes(effort)) {
        supportedEffortLevels.push(effort);
      }
    }
    if (supportedEffortLevels.length === 0) {
      continue;
    }
    const declaredDefault = (entry as { default_reasoning_level?: unknown }).default_reasoning_level;
    catalog.set(slug.trim(), {
      supportedEffortLevels,
      ...(isEffortLevel(declaredDefault) && supportedEffortLevels.includes(declaredDefault)
        ? { defaultEffortLevel: declaredDefault }
        : {}),
    });
  }
  return catalog;
}

/**
 * Effort capabilities from the model catalog config.toml's `model_catalog_json`
 * names -- the same file Codex's `model/list` serves custom models from. Empty
 * when no catalog is configured or it cannot be read.
 */
export async function readCodexModelCatalog(toml: string | null): Promise<CodexModelCatalog> {
  const catalogPath = toml ? resolveCodexModelCatalogPath(toml, resolveCodexHome()) : null;
  if (!catalogPath) {
    return new Map();
  }
  try {
    return parseCodexModelCatalog(await fs.readFile(catalogPath, 'utf8'));
  } catch {
    return new Map();
  }
}

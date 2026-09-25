import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isEffortLevel, type EffortLevel } from '../../effortLevels';

/** Codex's built-in provider id for OpenAI's own models. */
export const CODEX_OPENAI_MODEL_PROVIDER = 'openai';

const PROFILE_SUFFIX = '.config.toml';

/**
 * A model the user declared in their Codex configuration. Only model metadata
 * is ever read: provider tables, `env_key` values, tokens and every other key
 * stay owned by Codex.
 */
export interface CodexCustomModel {
  model: string;
  /** `model_provider` Codex pairs with this model, if the config sets one. */
  provider?: string;
  /** Profile-v2 name (`$CODEX_HOME/<profile>.config.toml`) that declares it. */
  profile?: string;
  /** Absolute path of the model catalog the declaring config names. */
  catalogPath?: string;
  /**
   * Exact effort levels the catalog declares. An empty array is authoritative:
   * the model advertises no selectable reasoning level.
   */
  supportedEffortLevels?: EffortLevel[];
  defaultEffortLevel?: EffortLevel;
}

export interface CodexModelDiscovery {
  /** Profile-v2 models first, then legacy config.toml models they do not shadow. */
  models: CodexCustomModel[];
  /** The catalog config.toml's top-level `model_catalog_json` names. */
  baseCatalog: CodexModelCatalog;
  /**
   * Whether an undeclared model must be pinned to Codex's `openai` provider so
   * it never inherits a custom one. False when nothing custom is configured,
   * which leaves Codex's default untouched.
   */
  pinsOpenAIProvider: boolean;
}

/** Effort capabilities a custom model catalog declares for one model. */
export interface CodexModelEffortInfo {
  supportedEffortLevels: EffortLevel[];
  defaultEffortLevel?: EffortLevel;
}

/** Catalog effort capabilities keyed by model slug. */
export type CodexModelCatalog = Map<string, CodexModelEffortInfo>;

export function emptyCodexModelDiscovery(): CodexModelDiscovery {
  return { models: [], baseCatalog: new Map(), pinsOpenAIProvider: false };
}

/** Codex's home directory, honoring `CODEX_HOME` the way the Codex CLI does. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/** `~` expands to the home directory; a relative path resolves against the Codex home. */
function resolveConfigPath(value: string, codexHome: string, homeDir: string): string {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(homeDir, value.slice(1));
  }
  return path.resolve(codexHome, value);
}

/**
 * Top-level string values for `keys`, stopping at the first table header and
 * skipping multi-line string bodies. A key present with anything but a plain
 * quoted string maps to null so the caller can reject the file.
 */
function readTopLevelStrings(toml: string, keys: readonly string[]): Map<string, string | null> {
  const values = new Map<string, string | null>();
  let openMultiline: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    if (openMultiline) {
      if (line.includes(openMultiline)) {
        openMultiline = null;
      }
      continue;
    }
    if (/^\s*\[/.test(line)) {
      break;
    }
    const assignment = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) {
      continue;
    }
    for (const delimiter of ['"""', "'''"]) {
      if (assignment[2].split(delimiter).length % 2 === 0) {
        openMultiline = delimiter;
      }
    }
    if (!keys.includes(assignment[1])) {
      continue;
    }
    const scalar = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(assignment[2]);
    const value = scalar
      ? (scalar[1] !== undefined ? scalar[1].replace(/\\(["\\])/g, '$1') : scalar[2]).trim()
      : '';
    values.set(assignment[1], value || null);
  }
  return values;
}

/** A profile-v2 file's model metadata. */
export interface CodexProfile {
  name: string;
  model: string;
  provider?: string;
  reasoningEffort?: EffortLevel;
  catalogPath?: string;
}

/**
 * Parse `$CODEX_HOME/<name>.config.toml`. Only `model`, `model_provider`,
 * `model_reasoning_effort` and `model_catalog_json` are read. Returns null
 * for a profile with no model or with one of those keys malformed -- Codex
 * would refuse to load it, so Nimbalyst must not offer it.
 */
export function parseCodexProfile(
  name: string,
  toml: string,
  codexHome: string,
  homeDir: string = os.homedir(),
): CodexProfile | null {
  const values = readTopLevelStrings(toml, ['model', 'model_provider', 'model_reasoning_effort', 'model_catalog_json']);
  const model = values.get('model');
  if (!model || [...values.values()].includes(null)) {
    return null;
  }
  const provider = values.get('model_provider');
  const effort = values.get('model_reasoning_effort');
  const catalog = values.get('model_catalog_json');
  return {
    name,
    model,
    ...(provider ? { provider } : {}),
    ...(isEffortLevel(effort) ? { reasoningEffort: effort } : {}),
    ...(catalog ? { catalogPath: resolveConfigPath(catalog, codexHome, homeDir) } : {}),
  };
}

/**
 * Legacy models config.toml declares: the top-level `model` and each
 * `[profiles.<name>]` `model`, each with the `model_provider` Codex would pair
 * it with (a profile inherits the top-level one, as in Codex). Kept only for
 * configs that predate profile-v2 files.
 */
export function parseCodexConfigModels(toml: string): CodexCustomModel[] {
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

  const models: CodexCustomModel[] = [];
  for (const entry of [topLevel, ...profiles]) {
    const provider = entry.provider ?? topLevel.provider;
    if (entry.model && !models.some((existing) => existing.model === entry.model)) {
      models.push(provider ? { model: entry.model, provider } : { model: entry.model });
    }
  }
  return models;
}

/**
 * Absolute path of the top-level `model_catalog_json` config.toml points at,
 * or null when it sets none.
 */
export function resolveCodexModelCatalogPath(
  toml: string,
  codexHome: string,
  homeDir: string = os.homedir(),
): string | null {
  const value = readTopLevelStrings(toml, ['model_catalog_json']).get('model_catalog_json');
  return value ? resolveConfigPath(value, codexHome, homeDir) : null;
}

/**
 * Parse a Codex model catalog (`{ models: [...] }`) down to each model's
 * declared effort levels. Only `slug`, `supported_reasoning_levels[].effort`
 * and `default_reasoning_level` are read; levels Nimbalyst has no name for are
 * dropped. A model that declares the array keeps its entry even when it ends
 * up empty: an empty set means "no selectable reasoning", not "unknown".
 * Malformed input yields an empty catalog.
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
    const levels = (entry as { supported_reasoning_levels?: unknown } | null)?.supported_reasoning_levels;
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

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Every well-formed `$CODEX_HOME/<name>.config.toml`, sorted by name. */
export async function readCodexProfiles(codexHome: string, homeDir: string = os.homedir()): Promise<CodexProfile[]> {
  let names: string[];
  try {
    names = await fs.readdir(codexHome);
  } catch {
    return [];
  }
  const profiles: CodexProfile[] = [];
  for (const file of names.filter((entry) => entry.endsWith(PROFILE_SUFFIX) && entry.length > PROFILE_SUFFIX.length).sort()) {
    const toml = await readText(path.join(codexHome, file));
    const profile = toml === null ? null : parseCodexProfile(file.slice(0, -PROFILE_SUFFIX.length), toml, codexHome, homeDir);
    if (profile) {
      profiles.push(profile);
    }
  }
  return profiles;
}

/**
 * Custom models from the Codex home: profile-v2 files that pair a model with a
 * non-OpenAI `model_provider` (a profile that only tunes an OpenAI model is
 * not a model of its own), then legacy config.toml models they do not shadow.
 * Each model's effort levels come from the catalog its own config names.
 */
export async function discoverCodexModels(
  options: { codexHome?: string; homeDir?: string } = {},
): Promise<CodexModelDiscovery> {
  const codexHome = options.codexHome ?? resolveCodexHome();
  const homeDir = options.homeDir ?? os.homedir();
  const catalogs = new Map<string, Promise<CodexModelCatalog>>();
  const readCatalog = (catalogPath: string): Promise<CodexModelCatalog> => {
    let catalog = catalogs.get(catalogPath);
    if (!catalog) {
      catalog = readText(catalogPath).then((json) => (json ? parseCodexModelCatalog(json) : new Map()));
      catalogs.set(catalogPath, catalog);
    }
    return catalog;
  };

  const models: CodexCustomModel[] = [];
  for (const profile of await readCodexProfiles(codexHome, homeDir)) {
    if (!profile.provider || profile.provider === CODEX_OPENAI_MODEL_PROVIDER || models.some((entry) => entry.model === profile.model)) {
      continue;
    }
    const info = profile.catalogPath ? (await readCatalog(profile.catalogPath)).get(profile.model) : undefined;
    const profileDefault = profile.reasoningEffort && (!info || info.supportedEffortLevels.includes(profile.reasoningEffort))
      ? profile.reasoningEffort
      : undefined;
    const defaultEffortLevel = info?.defaultEffortLevel ?? profileDefault;
    models.push({
      model: profile.model,
      provider: profile.provider,
      profile: profile.name,
      ...(profile.catalogPath ? { catalogPath: profile.catalogPath } : {}),
      ...(info ? { supportedEffortLevels: info.supportedEffortLevels } : {}),
      ...(defaultEffortLevel ? { defaultEffortLevel } : {}),
    });
  }

  const configToml = await readText(path.join(codexHome, 'config.toml'));
  const baseCatalogPath = configToml ? resolveCodexModelCatalogPath(configToml, codexHome, homeDir) : null;
  const baseCatalog = baseCatalogPath ? await readCatalog(baseCatalogPath) : new Map() as CodexModelCatalog;
  for (const legacy of configToml ? parseCodexConfigModels(configToml) : []) {
    if (!models.some((entry) => entry.model === legacy.model)) {
      models.push({ ...legacy, ...baseCatalog.get(legacy.model) });
    }
  }

  return {
    models,
    baseCatalog,
    pinsOpenAIProvider: /^\s*model_provider\s*=/m.test(configToml ?? '')
      || models.some((entry) => entry.provider && entry.provider !== CODEX_OPENAI_MODEL_PROVIDER),
  };
}

/**
 * What a Nimbalyst-selected model runs as. A declared model keeps its own
 * provider, profile and catalog; any other model is an OpenAI catalog model on
 * Codex's built-in `openai` provider, with no profile.
 */
export function resolveCodexModel(discovery: CodexModelDiscovery, model: string): CodexCustomModel {
  const declared = discovery.models.find((entry) => entry.model === model);
  if (declared) {
    return declared.provider || !discovery.pinsOpenAIProvider
      ? declared
      : { ...declared, provider: CODEX_OPENAI_MODEL_PROVIDER };
  }
  return {
    model,
    ...(discovery.pinsOpenAIProvider ? { provider: CODEX_OPENAI_MODEL_PROVIDER } : {}),
    ...discovery.baseCatalog.get(model),
  };
}

/**
 * `codex app-server` config overrides that apply a profile-backed model.
 * Codex 0.157 rejects `--profile` for `app-server` ("--profile only applies to
 * runtime commands"), so the profile's model metadata is layered with `-c`
 * instead. Returns no arguments for a model without a profile.
 */
export function codexProfileLaunchArgs(model: CodexCustomModel | undefined): string[] {
  if (!model?.profile) {
    return [];
  }
  const overrides: Array<[string, string | undefined]> = [
    ['model', model.model],
    ['model_provider', model.provider],
    ['model_catalog_json', model.catalogPath],
  ];
  return overrides.flatMap(([key, value]) => (value ? ['-c', `${key}=${JSON.stringify(value)}`] : []));
}

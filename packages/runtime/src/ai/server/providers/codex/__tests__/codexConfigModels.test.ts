// @vitest-environment node
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codexProfileLaunchArgs,
  discoverCodexModels,
  parseCodexConfigModels,
  parseCodexModelCatalog,
  resolveCodexHome,
  resolveCodexModel,
  resolveCodexModelCatalogPath,
} from '../codexConfigModels';

const SECRET = 'sk-SECRET-value';

const catalog = (models: Array<{ slug: string; levels: string[]; defaultLevel: string | null }>) => JSON.stringify({
  models: models.map(({ slug, levels, defaultLevel }) => ({
    slug,
    base_instructions: 'You are Codex',
    experimental_bearer_token: SECRET,
    default_reasoning_level: defaultLevel,
    supported_reasoning_levels: levels.map((effort) => ({ effort, description: effort })),
  })),
});

const deepseekCatalog = catalog([
  { slug: 'deepseek-flash', levels: ['low', 'high', 'max'], defaultLevel: 'high' },
  { slug: 'deepseek-v4-pro', levels: ['low', 'high', 'max'], defaultLevel: 'high' },
]);
const qwenCatalog = catalog([{ slug: 'Qwen3-Coder-30B-A3B-Instruct-ovh', levels: [], defaultLevel: null }]);

describe('Codex profile-v2 model discovery', () => {
  let codexHome: string;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-user-'));
    codexHome = path.join(homeDir, 'custom-codex');
    await fs.mkdir(codexHome);
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      '[model_providers.deepseek]',
      'base_url = "https://api.deepseek.com"',
      'env_key = "DEEPSEEK_API_KEY"',
      `experimental_bearer_token = "${SECRET}"`,
      '[model_providers.chaps_qwen]',
      'env_key = "CHAPSVISION_API_KEY"',
      '[profiles.legacy]',
      'model = "deepseek-flash"',
      'model_provider = "legacy-provider"',
      '[profiles.old]',
      'model = "old-model"',
      'model_provider = "deepseek"',
    ].join('\n'));
    await fs.writeFile(path.join(homeDir, 'models.json'), deepseekCatalog);
    await fs.writeFile(path.join(codexHome, 'qwen-model-catalog.json'), qwenCatalog);
    await fs.writeFile(path.join(codexHome, 'deepseek-flash.config.toml'), [
      'model = "deepseek-flash"',
      'model_provider = "deepseek"',
      'model_reasoning_effort = "max"',
      `api_key = "${SECRET}"`,
      'model_catalog_json = "~/models.json"',
    ].join('\n'));
    await fs.writeFile(path.join(codexHome, 'qwen-worker.config.toml'), [
      'model = "Qwen3-Coder-30B-A3B-Instruct-ovh"',
      'model_provider = "chaps_qwen"',
      '# relative to CODEX_HOME',
      "model_catalog_json = 'qwen-model-catalog.json'",
      'developer_instructions = """',
      'model = "injected-from-a-string-body"',
      '"""',
    ].join('\n'));
    // Malformed: unquoted catalog path, which Codex itself refuses to load.
    await fs.writeFile(path.join(codexHome, 'qwen3-coder.config.toml'), 'model = "Qwen3-32B"\nmodel_provider = "chaps_qwen"\nmodel_catalog_json = ~/q.json\n');
    // An OpenAI tuning profile is not a model of its own.
    await fs.writeFile(path.join(codexHome, 'quick.config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n');
    await fs.writeFile(path.join(codexHome, 'empty.config.toml'), '[tui]\nmodel = "not-top-level"\n');
    await fs.writeFile(path.join(codexHome, '.config.toml'), 'model = "nameless"\nmodel_provider = "x"\n');
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('honors CODEX_HOME', () => {
    expect(resolveCodexHome({ CODEX_HOME: codexHome })).toBe(codexHome);
    expect(resolveCodexHome({})).toBe(path.join(os.homedir(), '.codex'));
  });

  it('discovers profile files with their own catalogs, before legacy entries, skipping malformed ones', async () => {
    const discovery = await discoverCodexModels({ codexHome, homeDir });
    expect(discovery.models).toEqual([
      {
        model: 'deepseek-flash',
        provider: 'deepseek',
        profile: 'deepseek-flash',
        catalogPath: path.join(homeDir, 'models.json'),
        supportedEffortLevels: ['low', 'high', 'max'],
        defaultEffortLevel: 'high',
      },
      {
        model: 'Qwen3-Coder-30B-A3B-Instruct-ovh',
        provider: 'chaps_qwen',
        profile: 'qwen-worker',
        catalogPath: path.join(codexHome, 'qwen-model-catalog.json'),
        supportedEffortLevels: [],
      },
      // The legacy deepseek-flash entry is shadowed by the profile-v2 one.
      { model: 'old-model', provider: 'deepseek' },
    ]);
    expect(JSON.stringify(discovery)).not.toContain(SECRET);
    expect(JSON.stringify(discovery)).not.toContain('_API_KEY');
  });

  it('resolves each selected model to its own provider, profile and catalog', async () => {
    const discovery = await discoverCodexModels({ codexHome, homeDir });
    expect(resolveCodexModel(discovery, 'deepseek-flash')).toMatchObject({ provider: 'deepseek', profile: 'deepseek-flash' });
    // deepseek-v4-pro is in the DeepSeek catalog but no profile declares it:
    // one profile's catalog must not leak onto other models.
    expect(resolveCodexModel(discovery, 'deepseek-v4-pro')).toEqual({ model: 'deepseek-v4-pro', provider: 'openai' });
    for (const gpt of ['gpt-6-luna', 'gpt-6-sol']) {
      expect(resolveCodexModel(discovery, gpt)).toEqual({ model: gpt, provider: 'openai' });
    }
    // With nothing custom configured, Codex keeps its default provider.
    const bare = await discoverCodexModels({ codexHome: path.join(homeDir, 'missing'), homeDir });
    expect(resolveCodexModel(bare, 'gpt-6-sol')).toEqual({ model: 'gpt-6-sol' });
  });

  it('uses the profile effort as default only when the catalog declares none', async () => {
    await fs.writeFile(path.join(homeDir, 'models.json'), catalog([
      { slug: 'deepseek-flash', levels: ['low', 'high', 'max'], defaultLevel: null },
    ]));
    const discovery = await discoverCodexModels({ codexHome, homeDir });
    expect(resolveCodexModel(discovery, 'deepseek-flash').defaultEffortLevel).toBe('max');
  });

  it('launches a profile-backed model with its metadata as -c overrides and OpenAI models with none', async () => {
    const discovery = await discoverCodexModels({ codexHome, homeDir });
    expect(codexProfileLaunchArgs(resolveCodexModel(discovery, 'deepseek-flash'))).toEqual([
      '-c', 'model="deepseek-flash"',
      '-c', 'model_provider="deepseek"',
      '-c', `model_catalog_json=${JSON.stringify(path.join(homeDir, 'models.json'))}`,
    ]);
    expect(codexProfileLaunchArgs(resolveCodexModel(discovery, 'Qwen3-Coder-30B-A3B-Instruct-ovh'))).toContain('model_provider="chaps_qwen"');
    expect(codexProfileLaunchArgs(resolveCodexModel(discovery, 'gpt-6-luna'))).toEqual([]);
    expect(codexProfileLaunchArgs(resolveCodexModel(discovery, 'old-model'))).toEqual([]);
  });
});

describe('model_catalog_json parsing', () => {
  it('keeps only effort capabilities, treats an empty level list as authoritative, and drops malformed input', () => {
    expect([...parseCodexModelCatalog(deepseekCatalog).entries()]).toEqual([
      ['deepseek-flash', { supportedEffortLevels: ['low', 'high', 'max'], defaultEffortLevel: 'high' }],
      ['deepseek-v4-pro', { supportedEffortLevels: ['low', 'high', 'max'], defaultEffortLevel: 'high' }],
    ]);
    expect(parseCodexModelCatalog(qwenCatalog).get('Qwen3-Coder-30B-A3B-Instruct-ovh')).toEqual({ supportedEffortLevels: [] });
    expect(parseCodexModelCatalog('not json').size).toBe(0);
    expect(parseCodexModelCatalog('{"models":{}}').size).toBe(0);
    expect(parseCodexModelCatalog('{"models":[{"slug":"no-levels-key"}]}').size).toBe(0);
  });

  it('resolves the top-level catalog path config.toml names, with ~ and relative paths', () => {
    const home = '/home/u';
    const codexHome = '/custom/codex';
    expect(resolveCodexModelCatalogPath('model_catalog_json = "~/.codex/models.json"\n', codexHome, home))
      .toBe('/home/u/.codex/models.json');
    expect(resolveCodexModelCatalogPath("model_catalog_json = 'catalogs/ds.json'\n", codexHome, home))
      .toBe('/custom/codex/catalogs/ds.json');
    expect(resolveCodexModelCatalogPath('model_catalog_json = "/etc/models.json"\n', codexHome, home))
      .toBe('/etc/models.json');
    expect(resolveCodexModelCatalogPath('model = "x"\n[profiles.p]\nmodel_catalog_json = "/p.json"\n', codexHome, home))
      .toBeNull();
  });
});

describe('legacy config.toml models', () => {
  it('parses only model/provider pairs, with profiles inheriting the top-level provider', () => {
    const models = parseCodexConfigModels([
      'model = "deepseek-flash"',
      'model_provider = "deepseek"',
      '[model_providers.deepseek]',
      'model = "not-a-model"',
      `experimental_bearer_token = "${SECRET}"`,
      '[profiles.x]',
      'model = "deepseek-chat"',
      '[profiles.local]',
      'model = "my-local-model"',
      'model_provider = "local-llm"',
    ].join('\n'));
    expect(models).toEqual([
      { model: 'deepseek-flash', provider: 'deepseek' },
      { model: 'deepseek-chat', provider: 'deepseek' },
      { model: 'my-local-model', provider: 'local-llm' },
    ]);
    expect(JSON.stringify(models)).not.toContain(SECRET);
  });
});

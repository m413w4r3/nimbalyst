import type { SessionOptions } from '../ProtocolInterface';
import type { ThreadStartParams } from './types';
import { resolveCodexPermissionProfile } from '../codexPermissionProfile';
import { clampEffortLevel, parseEffortLevel, type EffortLevel } from '../../effortLevels';

/**
 * The reasoning effort a Codex thread runs at, or null when the model's
 * catalog declares no selectable level (an empty set is authoritative).
 * Clamps to what this model accepts: an exact catalog set when one is
 * declared, else the static ceiling (gpt-5.4/5.5 stop at xhigh, the Luna
 * tiers at max, and only Astra/Sol/Terra reach ultra).
 */
export function resolveCodexReasoningEffort(
  requested: string | undefined,
  model: string | undefined,
  supportedEffortLevels?: EffortLevel[],
  defaultEffortLevel?: EffortLevel,
): EffortLevel | null {
  if (supportedEffortLevels?.length === 0) {
    return null;
  }
  return clampEffortLevel(parseEffortLevel(requested ?? defaultEffortLevel ?? 'high'), model, supportedEffortLevels);
}

export function buildCodexThreadStartParams(options: SessionOptions): ThreadStartParams {
  const permissionProfile = resolveCodexPermissionProfile(
    options.permissionMode,
    options.raw?.agentVerified === true,
  );

  // A custom model catalog (a profile's `model_catalog_json`) declares the
  // model's exact levels and default; the host resolves them per model.
  const reasoningEffort = resolveCodexReasoningEffort(
    options.raw?.effortLevel as string | undefined,
    options.model ?? undefined,
    options.raw?.codexSupportedEffortLevels as EffortLevel[] | undefined,
    options.raw?.codexDefaultEffortLevel as EffortLevel | undefined,
  );

  const systemPrompt = (options.raw?.systemPrompt as string | undefined) ?? options.systemPrompt;
  const additionalDirectories = Array.isArray(options.raw?.additionalDirectories)
    ? (options.raw?.additionalDirectories as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      )
    : [];

  // The free-form `config` object accepts the same dotted-path TOML overrides
  // the SDK transport sends as `--config` flags. We pass through the
  // existing host-computed overrides (which include `mcp_servers`,
  // `model_reasoning_effort`, network access, web_search, etc.) unchanged.
  const config: Record<string, unknown> = {
    ...(options.raw?.codexConfigOverrides as Record<string, unknown> | undefined ?? {}),
    // Reasoning effort always sets; the host's override map may also set it
    // but a literal here is fine since codex resolves these later.
    model_reasoning_effort: reasoningEffort,
  };
  if (reasoningEffort === null) {
    delete config.model_reasoning_effort;
  }

  // Pin the provider the host resolved for this model so it never inherits an
  // unrelated global `model_provider` from config.toml.
  const modelProvider = options.raw?.codexModelProvider as string | undefined;

  return {
    model: options.model ?? null,
    ...(modelProvider ? { modelProvider } : {}),
    sandbox: permissionProfile.sandboxMode,
    cwd: options.workspacePath,
    approvalPolicy: permissionProfile.approvalPolicy,
    ...(permissionProfile.approvalsReviewer
      ? { approvalsReviewer: permissionProfile.approvalsReviewer }
      : {}),
    ephemeral: false,
    developerInstructions: systemPrompt,
    config,
    ...(additionalDirectories.length > 0
      ? { config: { ...config, 'sandbox_workspace_write.writable_roots': [...new Set(additionalDirectories)] } }
      : {}),
  };
}

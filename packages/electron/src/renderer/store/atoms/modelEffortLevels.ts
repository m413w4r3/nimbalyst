/**
 * Exact effort levels a model's own catalog declares, keyed by full model id.
 *
 * Written from the `ai:getModels` listing the model picker already preloads;
 * read by the effort selector. A model absent here keeps the static per-model
 * ceiling from effortLevels.ts, so this only ever narrows or reshapes the menu
 * for models that declare their levels (custom Codex `model_catalog_json`).
 */

import { atom } from 'jotai';
import type { EffortLevel } from '../../utils/modelUtils';

export const modelEffortLevelsAtom = atom<Record<string, EffortLevel[]>>({});

/** Collect declared effort levels from an `ai:getModels` grouped listing. */
export function collectModelEffortLevels(
  grouped: Record<string, Array<{ id: string; supportedEffortLevels?: EffortLevel[] }>>,
): Record<string, EffortLevel[]> {
  const result: Record<string, EffortLevel[]> = {};
  for (const models of Object.values(grouped)) {
    for (const model of models) {
      if (Array.isArray(model.supportedEffortLevels) && model.supportedEffortLevels.length > 0) {
        result[model.id] = model.supportedEffortLevels;
      }
    }
  }
  return result;
}

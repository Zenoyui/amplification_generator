// Model assembly: template + parameters + reinforcements -> signed distance field and metadata

import { beam } from './templates/beam.js';
import { angle } from './templates/angle.js';
import { lever } from './templates/lever.js';
import { post } from './templates/post.js';
import { resolveParams, defaultsOf } from './params.js';

export const TEMPLATES = [beam, angle, lever, post];

// Added volume above this share of the base volume is refused; above WARN_SHARE a warning is issued
export const ADDED_VOLUME_REFUSE = 0.5;
export const ADDED_VOLUME_WARN = 0.25;

export function findTemplate(id) {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`template unknown (id=${id})`);
  return template;
}

export function templateDefaults(templateId) {
  return defaultsOf(findTemplate(templateId).params);
}

// Parameter specs of a feature kind for the given resolved base values
export function featureSpecs(templateId, kind, base_m) {
  const template = findTemplate(templateId);
  const feature = template.features[kind];
  if (!feature) throw new Error(`feature unknown (template=${templateId}, kind=${kind})`);
  return feature.specs(base_m);
}

// Which feature kinds can still be added: unique kinds only once
export function availableFeatureKinds(templateId, current) {
  const template = findTemplate(templateId);
  return Object.entries(template.features)
    .filter(([kind, def]) => !(def.unique && current.some((f) => f.kind === kind)))
    .map(([kind, def]) => ({ kind, name: def.name }));
}

// raw: base values in display units; features: [{ id, kind, raw }] (raw values in display units)
// Returns { model, errors, base_m, features }; model is null when errors is not empty.
export function buildModel(templateId, raw, featureInputs) {
  const template = findTemplate(templateId);
  const base = resolveParams(template.params, raw);
  const errors = base.errors.map((e) => ({ scope: 'base', ...e }));
  if (errors.length === 0) {
    for (const message of template.checkBase?.(base.values) ?? []) errors.push({ scope: 'base', key: '', label: 'Размеры', message });
  }
  const features = [];
  if (errors.length === 0) {
    for (const input of featureInputs) {
      const def = template.features[input.kind];
      const specs = def.specs(base.values);
      const resolved = resolveParams(specs, input.raw);
      for (const e of resolved.errors) errors.push({ scope: input.id, kind: input.kind, ...e });
      if (resolved.errors.length === 0) {
        for (const message of def.check(base.values, resolved.values)) {
          errors.push({ scope: input.id, kind: input.kind, key: '', label: def.name, message });
        }
      }
      features.push({ id: input.id, kind: input.kind, name: def.name, specs, values: resolved.values });
    }
  }
  if (errors.length > 0) return { model: null, errors, base_m: base.values, features };
  const built = template.build(base.values, features);
  const baseOnly = template.build(base.values, []);
  const model = {
    templateId,
    templateName: template.name,
    base_m: base.values,
    baseSpecs: template.params,
    features,
    baseSdf: baseOnly.sdf,
    baseBounds_m: baseOnly.bounds_m,
    ...built,
  };
  return { model, errors, base_m: base.values, features };
}

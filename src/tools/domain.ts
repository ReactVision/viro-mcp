/**
 * domain.ts — ViroReact AR domain reference.
 *
 * Curated knowledge (lighting models, physics body types, easings, shader
 * modifier entry points) lives in data/ar-domain.json so it can be edited
 * without recompiling. It is served as reference docs through get_docs.
 *
 * Tools:
 *   - reactviro_changelog_since
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../config.js';
import type { StarterDb } from '../db.js';

const P = config.toolPrefix;

interface ArDomain {
  lighting_models: { name: string; description: string; when_to_use: string; required_props: string[]; optional_props: string[]; platforms: string }[];
  physics_body_types: { name: string; description: string; when_to_use: string; required_props: string[]; optional_props: string[] }[];
  animation_easings: { name: string; curve: string; use_for: string }[];
  shader_modifier_entry_points: { name: string; stage: string; purpose: string; uniforms_visible: string }[];
}

let domainCache: ArDomain | null = null;
function loadDomain(): ArDomain | null {
  if (domainCache) return domainCache;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, '..', '..', '..', 'data', 'ar-domain.json'),
    join(__dirname, '..', '..', 'data', 'ar-domain.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { domainCache = JSON.parse(readFileSync(p, 'utf-8')) as ArDomain; return domainCache; }
      catch { /* fall through */ }
    }
  }
  return null;
}

export interface ReferenceDoc { name: string; path: string; content: string }

const REFERENCE_PATH = 'data/ar-domain.json';

function propList(title: string, props: string[]): string[] {
  return props.length > 0 ? [`\n**${title}:**`, ...props.map(r => `- \`${r}\``)] : [];
}

/** The curated catalogs, as docs for get_docs. Empty when the data file is missing. */
export function referenceDocs(): ReferenceDoc[] {
  const d = loadDomain();
  if (!d) return [];

  const lighting: string[] = [`# ViroMaterials — Lighting Models\n`];
  for (const m of d.lighting_models) {
    lighting.push(`## ${m.name}`, `${m.description}\n`, `**Use when:** ${m.when_to_use}`, `**Platforms:** ${m.platforms}`);
    lighting.push(...propList('Required props', m.required_props), ...propList('Optional props', m.optional_props), '');
  }

  const physics: string[] = [`# Physics Body Types\n`];
  for (const t of d.physics_body_types) {
    physics.push(`## ${t.name}`, `${t.description}\n`, `**Use when:** ${t.when_to_use}`);
    physics.push(...propList('Required', t.required_props), ...propList('Optional', t.optional_props), '');
  }

  const easings: string[] = [`# Animation Easings\n`, `| Easing | Curve | Use for |`, `|--------|-------|---------|`];
  for (const e of d.animation_easings) easings.push(`| **${e.name}** | ${e.curve} | ${e.use_for} |`);

  const shaders: string[] = [`# ShaderModifiers — Entry Points\n`, `| Entry | Stage | Purpose | Visible uniforms |`, `|-------|-------|---------|------------------|`];
  for (const e of d.shader_modifier_entry_points) shaders.push(`| **${e.name}** | ${e.stage} | ${e.purpose} | \`${e.uniforms_visible}\` |`);
  shaders.push(`\n_See SHADER_REFERENCE (\`${P}_get_docs name="SHADER_REFERENCE"\`) for the full uniform/function reference._`);

  return [
    { name: 'LIGHTING_MODELS', content: lighting.join('\n') },
    { name: 'PHYSICS_BODY_TYPES', content: physics.join('\n') },
    { name: 'ANIMATION_EASINGS', content: easings.join('\n') },
    { name: 'SHADER_MODIFIERS', content: shaders.join('\n') },
  ].map(doc => ({ ...doc, path: REFERENCE_PATH }));
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerDomainTools(server: McpServer, db: StarterDb): void {

  // ── changelog_since ───────────────────────────────────────────────────────
  server.registerTool(`${P}_changelog_since`, {
    title: 'CHANGELOG Since Version',
    description: `Parses the indexed CHANGELOG and returns every entry from the given version onwards (inclusive of newer releases).

Useful for "what changed since I last upgraded?" and migration prep.

Args:
  - version: Version string (e.g. "2.50.0", "2.55", or "v2.55.0"). Loose matching — the tool finds the closest header.`,
    inputSchema: z.object({
      version: z.string().min(1),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ version }) => {
    const doc = db.getDoc('CHANGELOG');
    if (!doc) return { content: [{ type: 'text', text: 'CHANGELOG not indexed.' }] };

    const lines = doc.content.split('\n');
    const wantedVersion = version.replace(/^v/, '').trim();

    // Find every markdown header that looks like a version (## 2.55.0 or ## [2.55.0])
    const versionHeader = /^(#{1,3})\s*\[?v?(\d+\.\d+(?:\.\d+)?)\]?/;
    const sections: { startLine: number; version: string; headerLine: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(versionHeader);
      if (m) sections.push({ startLine: i, version: m[2]!, headerLine: lines[i]! });
    }

    if (sections.length === 0) {
      return { content: [{ type: 'text', text: 'No version headers found in CHANGELOG. The file format may be non-standard.' }] };
    }

    // Find the cutoff section (the one matching wantedVersion)
    const cutoffIdx = sections.findIndex(s => s.version === wantedVersion);
    if (cutoffIdx === -1) {
      const list = sections.slice(0, 10).map(s => `  - ${s.version}`).join('\n');
      return { content: [{ type: 'text', text: `Version "${wantedVersion}" not found in CHANGELOG.\n\nKnown versions:\n${list}${sections.length > 10 ? `\n  ...and ${sections.length - 10} more` : ''}` }] };
    }

    // Return everything from start of file up to (and including) the cutoff section.
    // CHANGELOGs are typically newest-first, so "since X" = everything above X's header
    // (newer versions) plus X itself.
    const endLine = cutoffIdx + 1 < sections.length ? sections[cutoffIdx + 1]!.startLine : lines.length;
    const slice = lines.slice(0, endLine).join('\n');

    return {
      content: [{ type: 'text', text: `# CHANGELOG since ${wantedVersion}\n_${cutoffIdx + 1} release${cutoffIdx + 1 !== 1 ? 's' : ''} including ${wantedVersion}_\n\n${slice}` }],
      structuredContent: { since: wantedVersion, releases_returned: cutoffIdx + 1 },
    };
  });
}

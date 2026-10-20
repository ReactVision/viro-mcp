/**
 * domain.ts — ReactViro AR domain tools.
 *
 * Curated knowledge (lighting models, physics body types, easings, shader
 * modifier entry points) lives in data/ar-domain.json so it can be edited
 * without recompiling. Tools that aggregate KB data (list_event_handlers,
 * changelog_since) read straight from SQLite + docs.
 *
 * Tools:
 *   - reactviro_list_lighting_models
 *   - reactviro_list_physics_body_types
 *   - reactviro_list_animation_easings
 *   - reactviro_get_shader_uniforms
 *   - reactviro_list_event_handlers
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

interface ExtractedEvent { name: string; signature: string; description?: string }

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

function baseNameNoExt(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(tsx|ts|jsx|js)$/i, '');
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerDomainTools(server: McpServer, db: StarterDb): void {

  // ── list_lighting_models ──────────────────────────────────────────────────
  server.registerTool(`${P}_list_lighting_models`, {
    title: 'List ViroMaterials Lighting Models',
    description: `Catalog of \`lightingModel\` options for \`ViroMaterials.createMaterials\`: PBR, Blinn, Lambert, Constant. Includes when to use each, required props, and optional props.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const d = loadDomain();
    if (!d) return { content: [{ type: 'text', text: 'data/ar-domain.json not found.' }] };

    const lines: string[] = [`# ViroMaterials — Lighting Models\n`];
    for (const m of d.lighting_models) {
      lines.push(`## ${m.name}`);
      lines.push(`${m.description}\n`);
      lines.push(`**Use when:** ${m.when_to_use}`);
      lines.push(`**Platforms:** ${m.platforms}`);
      lines.push(`\n**Required props:**`);
      for (const r of m.required_props) lines.push(`- \`${r}\``);
      if (m.optional_props.length > 0) {
        lines.push(`\n**Optional props:**`);
        for (const r of m.optional_props) lines.push(`- \`${r}\``);
      }
      lines.push('');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { lighting_models: d.lighting_models } };
  });

  // ── list_physics_body_types ───────────────────────────────────────────────
  server.registerTool(`${P}_list_physics_body_types`, {
    title: 'List Physics Body Types',
    description: `Catalog of \`physicsBody.type\` options: Static, Dynamic, Kinematic. Includes when to use each plus required/optional props.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const d = loadDomain();
    if (!d) return { content: [{ type: 'text', text: 'data/ar-domain.json not found.' }] };

    const lines: string[] = [`# Physics Body Types\n`];
    for (const t of d.physics_body_types) {
      lines.push(`## ${t.name}`);
      lines.push(`${t.description}\n`);
      lines.push(`**Use when:** ${t.when_to_use}`);
      lines.push(`\n**Required:**`);
      for (const r of t.required_props) lines.push(`- \`${r}\``);
      if (t.optional_props.length > 0) {
        lines.push(`\n**Optional:**`);
        for (const r of t.optional_props) lines.push(`- \`${r}\``);
      }
      lines.push('');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { physics_body_types: d.physics_body_types } };
  });

  // ── list_animation_easings ────────────────────────────────────────────────
  server.registerTool(`${P}_list_animation_easings`, {
    title: 'List Animation Easings',
    description: `Easing curves accepted by \`ViroAnimations.registerAnimations({ ... easing })\`: Linear, EaseIn, EaseOut, EaseInEaseOut, Bounce, PowerDecel, PowerAccel.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const d = loadDomain();
    if (!d) return { content: [{ type: 'text', text: 'data/ar-domain.json not found.' }] };

    const lines: string[] = [`# Animation Easings\n`, `| Easing | Curve | Use for |`, `|--------|-------|---------|`];
    for (const e of d.animation_easings) {
      lines.push(`| **${e.name}** | ${e.curve} | ${e.use_for} |`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { animation_easings: d.animation_easings } };
  });

  // ── get_shader_uniforms ───────────────────────────────────────────────────
  server.registerTool(`${P}_get_shader_uniforms`, {
    title: 'Shader Modifier Uniforms',
    description: `Catalog of \`shaderModifiers\` entry points (Geometric, Vertex, Surface, LightingModel, Fragment) with the pipeline stage they hook into and the uniforms available at each stage. For the deep reference, read the SHADER_REFERENCE doc with ${P}_get_docs.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const d = loadDomain();
    if (!d) return { content: [{ type: 'text', text: 'data/ar-domain.json not found.' }] };

    const lines: string[] = [`# ShaderModifiers — Entry Points\n`, `| Entry | Stage | Purpose | Visible uniforms |`, `|-------|-------|---------|------------------|`];
    for (const e of d.shader_modifier_entry_points) {
      lines.push(`| **${e.name}** | ${e.stage} | ${e.purpose} | \`${e.uniforms_visible}\` |`);
    }
    lines.push(`\n_See SHADER_REFERENCE.md (read with \`${P}_get_docs name="SHADER_REFERENCE"\`) for the full uniform/function reference._`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  // ── list_event_handlers ───────────────────────────────────────────────────
  server.registerTool(`${P}_list_event_handlers`, {
    title: 'List All Event Handlers Across Components',
    description: `Aggregates every \`on...\` event handler exposed by ReactViro components (sourced from the AST-extracted events_json).

Args:
  - search (optional): Substring filter (case-insensitive) on event name.
  - group_by ('event' | 'component'): How to group the output. Default 'event'.`,
    inputSchema: z.object({
      search:   z.string().optional(),
      group_by: z.enum(['event', 'component']).default('event'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ search, group_by }) => {
    const rows = db.listApi({ pkg: 'components' });
    const all: { component: string; event: ExtractedEvent }[] = [];
    for (const r of rows) {
      const events: ExtractedEvent[] = r.events_json ? JSON.parse(r.events_json) : [];
      const componentName = baseNameNoExt(r.path);
      for (const e of events) all.push({ component: componentName, event: e });
    }

    const filtered = search
      ? all.filter(x => x.event.name.toLowerCase().includes(search.toLowerCase()))
      : all;

    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No event handlers found${search ? ` matching "${search}"` : ''}.` }] };
    }

    if (group_by === 'component') {
      const byComp: Record<string, ExtractedEvent[]> = {};
      for (const x of filtered) (byComp[x.component] ??= []).push(x.event);
      const lines: string[] = [`# Event handlers — ${filtered.length} across ${Object.keys(byComp).length} components\n`];
      for (const [comp, events] of Object.entries(byComp).sort()) {
        lines.push(`## ${comp} (${events.length})`);
        for (const e of events) lines.push(`- \`${e.name}\` — \`${e.signature.slice(0, 100)}\`${e.description ? ` — ${e.description.slice(0, 80)}` : ''}`);
        lines.push('');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // group_by === 'event'
    const byEvent: Record<string, { component: string; signature: string; description?: string }[]> = {};
    for (const x of filtered) {
      (byEvent[x.event.name] ??= []).push({ component: x.component, signature: x.event.signature, ...(x.event.description ? { description: x.event.description } : {}) });
    }
    const sorted = Object.entries(byEvent).sort();
    const lines: string[] = [`# Event handlers — ${filtered.length} total · ${sorted.length} unique\n`];
    for (const [name, comps] of sorted) {
      lines.push(`## \`${name}\` _(${comps.length} component${comps.length !== 1 ? 's' : ''})_`);
      for (const c of comps) lines.push(`- **${c.component}** — \`${c.signature.slice(0, 100)}\``);
      lines.push('');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

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

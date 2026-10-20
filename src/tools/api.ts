/**
 * api.ts — Tools that consume AST-extracted props/events for ReactViro components.
 *
 * Data flows: indexer/ast.ts runs at index time and persists JSON in
 * files.props_json / files.events_json. These tools just deserialize and
 * format. Components without extracted API surface (extraction failed,
 * non-standard layout, etc.) are reported as such.
 *
 * Tools:
 *   - reactviro_get_component_props
 *   - reactviro_list_props
 *   - reactviro_get_component_events
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import type { StarterDb } from '../db.js';

const P = config.toolPrefix;

interface ExtractedProp {
  name:         string;
  type:         string;
  optional:     boolean;
  default?:     string;
  description?: string;
  since?:       string;
}

interface ExtractedEvent {
  name:         string;
  signature:    string;
  description?: string;
}

function baseNameNoExt(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(tsx|ts|jsx|js)$/i, '');
}

function findComponentByName(db: StarterDb, name: string): { path: string; props: ExtractedProp[]; events: ExtractedEvent[] } | null {
  const cleaned = name.replace(/\.(tsx|ts|jsx|js)$/i, '').trim();
  const lower = cleaned.toLowerCase();
  const candidates = [cleaned, lower.startsWith('viro') || lower.startsWith('studio') ? cleaned : `Viro${cleaned}`];

  const rows = db.listApi({ pkg: 'components' });
  for (const cand of candidates) {
    const exact = rows.find(r => baseNameNoExt(r.path).toLowerCase() === cand.toLowerCase());
    if (exact) {
      return {
        path:   exact.path,
        props:  exact.props_json  ? JSON.parse(exact.props_json)  as ExtractedProp[]  : [],
        events: exact.events_json ? JSON.parse(exact.events_json) as ExtractedEvent[] : [],
      };
    }
  }
  return null;
}

function suggestComponents(db: StarterDb, name: string, max = 8): string[] {
  const rows = db.listApi({ pkg: 'components' });
  const lower = name.toLowerCase();
  return rows
    .map(r => baseNameNoExt(r.path))
    .filter(b => b.toLowerCase().includes(lower.slice(0, 3)))
    .slice(0, max);
}

export function registerApiTools(server: McpServer, db: StarterDb): void {

  // ── get_component_props ───────────────────────────────────────────────────
  server.registerTool(`${P}_get_component_props`, {
    title: 'Get Component Props Schema',
    description: `Returns the AST-extracted props schema for a ReactViro component — name, type, optionality, JSDoc description, @since tag.

This is the source of truth for what props each component accepts. Use it before generating or validating scenes.

Args:
  - name: Component name (e.g. "ViroBox", "Box", "ARScene")
  - response_format: "markdown" (default) | "json"`,
    inputSchema: z.object({
      name:            z.string().min(1),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
    }).strict(`Unknown argument. ${P}_get_component_props takes \`name\`, one component. To browse components by category, use ${P}_list_components.`),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name, response_format }) => {
    const found = findComponentByName(db, name);
    if (!found) {
      const suggestions = suggestComponents(db, name);
      return {
        content: [{ type: 'text', text: `No AST-extracted props for "${name}".${suggestions.length ? `\n\nDid you mean: ${suggestions.join(', ')}` : ''}\n\nNote: extraction can fail for components with non-standard Props layouts. Use ${P}_get_component to read the raw source.` }],
      };
    }

    const componentName = baseNameNoExt(found.path);

    if (response_format === 'json') {
      const payload = { component: componentName, path: found.path, props: found.props, events: found.events };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    }

    const lines: string[] = [
      `# ${componentName} — Props\n`,
      `_Source: \`${found.path}\`_\n`,
    ];
    if (found.props.length === 0) {
      lines.push(`_No non-event props extracted._`);
    } else {
      lines.push(`| Prop | Type | Optional | Description |`);
      lines.push(`|------|------|:---:|-------------|`);
      for (const p of found.props) {
        const desc = (p.description ?? '').replace(/\|/g, '\\|').slice(0, 120);
        const since = p.since ? ` _(since ${p.since})_` : '';
        const type = '`' + p.type.replace(/\|/g, '\\|').slice(0, 80) + '`';
        lines.push(`| **${p.name}** | ${type} | ${p.optional ? '✓' : ''} | ${desc}${since} |`);
      }
    }
    if (found.events.length > 0) {
      lines.push(`\n## Events (${found.events.length})\n`);
      for (const e of found.events) {
        lines.push(`- **${e.name}** — \`${e.signature.slice(0, 100)}\`${e.description ? ` — ${e.description.slice(0, 120)}` : ''}`);
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { component: componentName, path: found.path, props: found.props, events: found.events },
    };
  });

  // ── list_props ────────────────────────────────────────────────────────────
  server.registerTool(`${P}_list_props`, {
    title: 'Find Components by Prop Name',
    description: `Inverse lookup: given a prop name (or pattern), returns every component that declares it.

Useful for questions like "which components have a \`castsShadow\` prop?" or "what accepts \`physicsBody\`?".

Args:
  - prop: Prop name or substring (case-insensitive). Examples: "castsShadow", "shaderModifiers", "physics", "position"
  - exact (default false): If true, only return exact name matches.
  - limit: Max components returned (default 50).`,
    inputSchema: z.object({
      prop:  z.string().min(1),
      exact: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ prop, exact, limit }) => {
    const needle = prop.toLowerCase();
    const rows = db.listApi({ pkg: 'components' });
    const hits: { component: string; path: string; prop: ExtractedProp }[] = [];

    for (const r of rows) {
      const props: ExtractedProp[] = r.props_json ? JSON.parse(r.props_json) : [];
      const events: ExtractedEvent[] = r.events_json ? JSON.parse(r.events_json) : [];
      const componentName = baseNameNoExt(r.path);
      for (const p of props) {
        const match = exact ? p.name === prop : p.name.toLowerCase().includes(needle);
        if (match) hits.push({ component: componentName, path: r.path, prop: p });
      }
      for (const e of events) {
        const match = exact ? e.name === prop : e.name.toLowerCase().includes(needle);
        if (match) hits.push({ component: componentName, path: r.path, prop: { name: e.name, type: e.signature, optional: true, description: e.description ?? '(event handler)' } });
      }
      if (hits.length >= limit) break;
    }

    if (hits.length === 0) {
      return { content: [{ type: 'text', text: `No components declare a prop${exact ? '' : ' matching'} "${prop}".` }] };
    }

    const lines: string[] = [`# Components with prop \`${prop}\`${exact ? ' (exact)' : ''} — ${hits.length} match${hits.length !== 1 ? 'es' : ''}\n`];
    const byComponent: Record<string, typeof hits> = {};
    for (const h of hits) (byComponent[h.component] ??= []).push(h);
    for (const [comp, arr] of Object.entries(byComponent).sort()) {
      const props = arr.map(h => `\`${h.prop.name}: ${h.prop.type.slice(0, 60)}\``).join(', ');
      lines.push(`- **${comp}** — ${props}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { prop, exact, total: hits.length, hits },
    };
  });

  // ── get_component_events ──────────────────────────────────────────────────
  server.registerTool(`${P}_get_component_events`, {
    title: 'Get Component Event Handlers',
    description: `Returns the event-handler props for a component (props matching the \`onX\` naming convention), with their full TypeScript signatures.

Args:
  - name: Component name (e.g. "ViroARScene", "ViroARImageMarker")
  - response_format: "markdown" | "json"`,
    inputSchema: z.object({
      name:            z.string().min(1),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name, response_format }) => {
    const found = findComponentByName(db, name);
    if (!found) {
      const suggestions = suggestComponents(db, name);
      return {
        content: [{ type: 'text', text: `No AST data for "${name}".${suggestions.length ? `\n\nDid you mean: ${suggestions.join(', ')}` : ''}` }],
      };
    }
    const componentName = baseNameNoExt(found.path);

    if (response_format === 'json') {
      const payload = { component: componentName, path: found.path, events: found.events };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    }

    const lines: string[] = [`# ${componentName} — Events (${found.events.length})\n`, `_Source: \`${found.path}\`_\n`];
    if (found.events.length === 0) {
      lines.push(`_No event handlers declared._`);
    } else {
      for (const e of found.events) {
        lines.push(`### \`${e.name}\``);
        lines.push('```ts');
        lines.push(`${e.name}: ${e.signature}`);
        lines.push('```');
        if (e.description) lines.push(`> ${e.description}`);
        lines.push('');
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { component: componentName, path: found.path, events: found.events },
    };
  });
}

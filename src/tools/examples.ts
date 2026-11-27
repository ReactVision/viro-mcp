/**
 * examples.ts — Tools for the showcase ar-examples corpus.
 *
 * The indexer puts these files under pkg='examples'. This module exposes
 * them via dedicated tools so users can discover real-world scene patterns
 * without resorting to raw search.
 *
 * Tools:
 *   - reactviro_list_examples
 *   - reactviro_get_example
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import type { StarterDb } from '../db.js';

const P = config.toolPrefix;

function baseNameNoExt(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(tsx|ts|jsx|js)$/i, '');
}

export function registerExamplesTools(server: McpServer, db: StarterDb): void {

  // ── list_examples ─────────────────────────────────────────────────────────
  server.registerTool(`${P}_list_examples`, {
    title: 'List ViroReact Example Scenes',
    description: `Lists real-world AR scene examples from the @reactvision/showcase repo (ar-examples).

Examples cover plane detection, image tracking, custom shaders, particles, portals, depth/LiDAR collision, hand tracking, and more.

Args:
  - search (optional): Substring filter on the example name.
  - component (optional): Only the examples that use this component (e.g. "ViroParticleEmitter", "ParticleEmitter"), most occurrences first, with the lines where it appears. For "show me a real scene that uses X".
  - response_format: "markdown" | "json"`,
    inputSchema: z.object({
      search:          z.string().optional(),
      component:       z.string().min(1).optional(),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ search, component, response_format }) => {
    const { rows } = db.listFiles({ pkg: 'examples', limit: 5000, offset: 0 });
    const examples: { name: string; path: string; size: number; lines?: { line: number; text: string }[] }[] = rows
      .filter(r => r.path.endsWith('.tsx') || r.path.endsWith('.ts'))
      .map(r => ({ name: baseNameNoExt(r.path), path: r.path, size: r.size }));

    let filtered = search
      ? examples.filter(e => e.name.toLowerCase().includes(search.toLowerCase()))
      : examples;
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    let usedComponent: string | undefined;
    if (component) {
      const cleaned = component.replace(/\.(tsx|ts)$/i, '').trim();
      const lower = cleaned.toLowerCase();
      usedComponent = lower.startsWith('viro') || lower.startsWith('studio') ? cleaned : `Viro${cleaned}`;
      // Either form, at a word boundary.
      const escaped = [cleaned, usedComponent]
        .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      const hits = db.search({ query: `\\b(?:${escaped})\\b`, pkg: 'examples', limit: 300 });
      const byPath: Record<string, { line: number; text: string }[]> = {};
      for (const h of hits) (byPath[h.path] ??= []).push({ line: h.line, text: h.text });
      filtered = filtered
        .filter(e => byPath[e.path])
        .map(e => ({ ...e, lines: byPath[e.path]! }))
        .sort((a, b) => b.lines.length - a.lines.length);
    }

    if (response_format === 'json') {
      const payload = { total: filtered.length, ...(usedComponent ? { component: usedComponent } : {}), examples: filtered };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }

    const scope = `${search ? ` matching "${search}"` : ''}${usedComponent ? ` using \`${usedComponent}\`` : ''}`;
    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No examples found${scope}.` }] };
    }

    const lines: string[] = [`# ViroReact Examples — ${filtered.length}${scope}\n`];
    for (const e of filtered) {
      const kb = e.size > 1024 ? `${Math.round(e.size / 1024)} KB` : `${e.size} B`;
      lines.push(`- **${e.name}** — \`${e.path}\` · ${kb}`);
      for (const ln of (e.lines ?? []).slice(0, 3)) lines.push(`  - L${ln.line}: \`${ln.text.slice(0, 160)}\``);
    }
    lines.push(`\n_Use ${P}_get_example to read the source._`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  // ── get_example ───────────────────────────────────────────────────────────
  server.registerTool(`${P}_get_example`, {
    title: 'Get ViroReact Example Source',
    description: `Returns the full TypeScript/TSX source of an AR-example scene.

Args:
  - name: Example name (e.g. "plane-detection", "custom-shaders", "ar-portal", "particle-effects", "depth-mesh-collision"). Case-insensitive; extension optional.`,
    inputSchema: z.object({
      name: z.string().min(1),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name }) => {
    const cleaned = name.replace(/\.(tsx|ts|jsx|js)$/i, '').trim();

    const { rows } = db.listFiles({ pkg: 'examples', limit: 5000, offset: 0 });
    const candidates = rows.filter(r => {
      const b = baseNameNoExt(r.path).toLowerCase();
      return b === cleaned.toLowerCase() || b.includes(cleaned.toLowerCase());
    });

    if (candidates.length === 0) {
      const all = rows.map(r => baseNameNoExt(r.path));
      const suggestions = all.filter(b => b.toLowerCase().includes(cleaned.toLowerCase().slice(0, 3))).slice(0, 6);
      return {
        content: [{ type: 'text', text: `Example "${name}" not found.${suggestions.length ? `\n\nDid you mean: ${suggestions.join(', ')}` : ''}\n\nUse ${P}_list_examples to see the catalog.` }],
      };
    }

    // Prefer exact basename
    const exact = candidates.find(c => baseNameNoExt(c.path).toLowerCase() === cleaned.toLowerCase());
    const pick = exact ?? candidates[0]!;

    if (candidates.length > 1 && !exact) {
      const list = candidates.slice(0, 8).map(c => `  - ${baseNameNoExt(c.path)}`).join('\n');
      return { content: [{ type: 'text', text: `Multiple matches for "${name}":\n${list}\n\nBe more specific (use exact basename).` }] };
    }

    const file = db.getFile(pick.path);
    if (!file || file === 'multiple') return { content: [{ type: 'text', text: `Could not read ${pick.path}.` }] };

    const header = `// Example: ${baseNameNoExt(file.path)}\n// ${file.path}  (${Math.round(file.size / 1024)} KB)\n\n`;
    return { content: [{ type: 'text', text: header + file.source }] };
  });
}

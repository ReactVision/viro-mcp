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
 *   - reactviro_examples_using
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
    title: 'List ReactViro Example Scenes',
    description: `Lists real-world AR scene examples from the @reactvision/showcase repo (ar-examples).

Examples cover plane detection, image tracking, custom shaders, particles, portals, depth/LiDAR collision, hand tracking, and more.

Args:
  - search (optional): Substring filter on the example name.
  - response_format: "markdown" | "json"`,
    inputSchema: z.object({
      search:          z.string().optional(),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ search, response_format }) => {
    const { rows } = db.listFiles({ pkg: 'examples', limit: 5000, offset: 0 });
    const examples = rows
      .filter(r => r.path.endsWith('.tsx') || r.path.endsWith('.ts'))
      .map(r => ({ name: baseNameNoExt(r.path), path: r.path, size: r.size }));

    const filtered = search
      ? examples.filter(e => e.name.toLowerCase().includes(search.toLowerCase()))
      : examples;
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    if (response_format === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ total: filtered.length, examples: filtered }, null, 2) }],
        structuredContent: { total: filtered.length, examples: filtered },
      };
    }

    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No examples found${search ? ` matching "${search}"` : ''}.` }] };
    }

    const lines: string[] = [`# ReactViro Examples — ${filtered.length}${search ? ` matching "${search}"` : ''}\n`];
    for (const e of filtered) {
      const kb = e.size > 1024 ? `${Math.round(e.size / 1024)} KB` : `${e.size} B`;
      lines.push(`- **${e.name}** — \`${e.path}\` · ${kb}`);
    }
    lines.push(`\n_Use ${P}_get_example to read the source._`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  // ── get_example ───────────────────────────────────────────────────────────
  server.registerTool(`${P}_get_example`, {
    title: 'Get ReactViro Example Source',
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

  // ── examples_using ────────────────────────────────────────────────────────
  server.registerTool(`${P}_examples_using`, {
    title: 'Find Examples Using a Component',
    description: `Given a ReactViro component name (e.g. "ViroParticleEmitter", "ViroPortalScene"), returns every showcase example that uses it.

Useful for "show me a real scene that uses X" requests.

Args:
  - component: Component name (e.g. "ViroParticleEmitter", "ParticleEmitter", "ViroARScene")
  - limit: Max examples returned (default 30).`,
    inputSchema: z.object({
      component: z.string().min(1),
      limit:     z.number().int().min(1).max(100).default(30),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ component, limit }) => {
    const cleaned = component.replace(/\.(tsx|ts)$/i, '').trim();
    const lower = cleaned.toLowerCase();
    const withPrefix = lower.startsWith('viro') || lower.startsWith('studio') ? cleaned : `Viro${cleaned}`;

    // Build a regex that matches either the original or the prefixed form,
    // at a word boundary, to avoid false positives.
    const escaped = [cleaned, withPrefix]
      .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const pattern = `\\b(?:${escaped})\\b`;

    const hits = db.search({ query: pattern, pkg: 'examples', limit: limit * 3 });

    // Group hits by file (one example may use the component on multiple lines)
    const byFile: Record<string, { example: string; lines: { line: number; text: string }[] }> = {};
    for (const h of hits) {
      const name = baseNameNoExt(h.path);
      (byFile[h.path] ??= { example: name, lines: [] }).lines.push({ line: h.line, text: h.text });
    }

    const examples = Object.entries(byFile).map(([path, info]) => ({ path, ...info }));
    examples.sort((a, b) => b.lines.length - a.lines.length);
    const top = examples.slice(0, limit);

    if (top.length === 0) {
      return { content: [{ type: 'text', text: `No examples use \`${component}\`.` }] };
    }

    const lines: string[] = [`# Examples using \`${withPrefix}\` — ${top.length} example${top.length !== 1 ? 's' : ''}\n`];
    for (const e of top) {
      lines.push(`## ${e.example} _(${e.lines.length} occurrence${e.lines.length !== 1 ? 's' : ''})_`);
      lines.push(`\`${e.path}\``);
      for (const ln of e.lines.slice(0, 3)) {
        lines.push(`  - L${ln.line}: \`${ln.text.slice(0, 160)}\``);
      }
      lines.push('');
    }
    lines.push(`\n_Use ${P}_get_example to read full source._`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { component: withPrefix, total: top.length, examples: top },
    };
  });
}

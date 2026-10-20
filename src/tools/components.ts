/**
 * components.ts — Tools specific to the ReactViro component API.
 *
 * Builds on top of the generic db.listFiles/getFile from the starter:
 * adds category classification, name normalization (e.g. "Box" → "ViroBox"),
 * and the cross-platform support matrix.
 *
 * Tools:
 *   - reactviro_list_components
 *   - reactviro_get_component
 *   - reactviro_list_categories
 *   - reactviro_get_platform_matrix
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../config.js';
import type { StarterDb, FileRowMeta } from '../db.js';

const P = config.toolPrefix;

// ─── Category classification ─────────────────────────────────────────────────

/**
 * Maps a component filename prefix to a human-readable category.
 * Order matters: longer/more-specific prefixes should come first.
 */
const CATEGORY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['ViroAR',          'AR'],
  ['Viro360',         'Panoramic / 360°'],
  ['ViroAmbient',     'Lighting'],
  ['ViroDirectional', 'Lighting'],
  ['ViroOmni',        'Lighting'],
  ['ViroSpot',        'Lighting'],
  ['ViroLighting',    'Lighting'],
  ['Viro3D',          '3D Objects'],
  ['ViroBox',         'Geometry'],
  ['ViroSphere',      'Geometry'],
  ['ViroQuad',        'Geometry'],
  ['ViroPolygon',     'Geometry'],
  ['ViroPolyline',    'Geometry'],
  ['ViroCylinder',    'Geometry'],
  ['ViroGeometry',    'Geometry'],
  ['ViroSurface',     'Geometry'],
  ['ViroParticle',    'Effects'],
  ['ViroPortal',      'Portal'],
  ['ViroSound',       'Audio'],
  ['ViroSpatial',     'Audio'],
  ['ViroMaterial',    'Materials'],
  ['ViroAnimation',   'Animation'],
  ['ViroAnimated',    'Animation'],
  ['ViroText',        'UI'],
  ['ViroFlex',        'UI'],
  ['ViroButton',      'UI'],
  ['ViroSpinner',     'UI'],
  ['ViroImage',       'Media'],
  ['ViroVideo',       'Media'],
  ['ViroScene',       'Navigation'],
  ['ViroVR',          'Navigation'],
  ['ViroCamera',      'Camera'],
  ['ViroOrbit',       'Camera'],
  ['ViroController',  'Input'],
  ['ViroSkyBox',      'Environment'],
  ['ViroNode',        'Transform'],
  ['Studio',          'Studio'],
];

function getCategory(componentName: string): string {
  for (const [prefix, cat] of CATEGORY_PREFIXES) {
    if (componentName.startsWith(prefix)) return cat;
  }
  return 'Other';
}

/** Returns true when a filename (without extension) looks like a public component. */
function isComponentFile(basename: string): boolean {
  return basename.startsWith('Viro') || basename.startsWith('Studio');
}

function baseNameNoExt(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(tsx|ts|jsx|js)$/i, '');
}

// ─── Platform matrix loader ──────────────────────────────────────────────────

interface PlatformMatrix {
  platforms: string[];
  platform_labels: Record<string, string>;
  features: {
    feature: string;
    support: Record<string, boolean>;
    notes: string;
  }[];
}

let matrixCache: PlatformMatrix | null = null;
function loadPlatformMatrix(): PlatformMatrix | null {
  if (matrixCache) return matrixCache;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // From dist/src/tools/components.js, go up three to project root.
  const candidates = [
    join(__dirname, '..', '..', '..', 'data', 'platform-matrix.json'),
    join(__dirname, '..', '..', 'data', 'platform-matrix.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        matrixCache = JSON.parse(readFileSync(p, 'utf-8')) as PlatformMatrix;
        return matrixCache;
      } catch (e) {
        console.warn(`Failed to parse ${p}:`, e);
      }
    }
  }
  return null;
}

// ─── Tool registration ───────────────────────────────────────────────────────

export function registerComponentTools(server: McpServer, db: StarterDb): void {

  // ── list_components ──────────────────────────────────────────────────────
  server.registerTool(`${P}_list_components`, {
    title: 'List ReactViro Components',
    description: `Lists all ReactViro public components, grouped by semantic category.

Categories: AR, Geometry, Lighting, Materials, Animation, Effects, Portal,
Media, Audio, UI, Navigation, Camera, Input, Environment, Transform, Studio,
Panoramic / 360°, 3D Objects, Other.

Args:
  - category (string, optional): Filter to one category (case-insensitive).
  - limit (number): Max results (default 200).
  - offset (number): Pagination offset.
  - response_format ('markdown' | 'json'): Output format (default 'markdown').

Returns: component names + category + relative file path. Use
${P}_get_component to read the source.`,
    inputSchema: z.object({
      category:        z.string().optional(),
      limit:           z.number().int().min(1).max(500).default(200),
      offset:          z.number().int().min(0).default(0),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ category, limit, offset, response_format }) => {
    // Pull all component-pkg files, then filter to Viro*/Studio*
    const { rows } = db.listFiles({ pkg: 'components', limit: 5000, offset: 0 });
    const components = rows
      .filter(r => r.path.endsWith('.tsx') || r.path.endsWith('.ts'))
      .map(r => ({
        name: baseNameNoExt(r.path),
        category: '',
        file: r.path,
      }))
      .filter(c => isComponentFile(c.name))
      .map(c => ({ ...c, category: getCategory(c.name) }));

    components.sort((a, b) => a.name.localeCompare(b.name));

    const filtered = category
      ? components.filter(c => c.category.toLowerCase() === category.toLowerCase())
      : components;

    const total = filtered.length;
    const slice = filtered.slice(offset, offset + limit);
    const has_more = total > offset + slice.length;

    const payload = {
      total, count: slice.length, offset, has_more,
      ...(has_more ? { next_offset: offset + slice.length } : {}),
      items: slice,
    };

    if (response_format === 'json') {
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    }

    const byCategory: Record<string, string[]> = {};
    for (const c of slice) (byCategory[c.category] ??= []).push(c.name);

    const lines: string[] = [`# ReactViro Components — ${total} total${category ? ` (${category})` : ''}\n`];
    for (const [cat, names] of Object.entries(byCategory).sort()) {
      lines.push(`## ${cat} (${names.length})`);
      lines.push(names.join(', '));
      lines.push('');
    }
    if (has_more) lines.push(`_Showing ${slice.length} of ${total}. Use offset=${offset + slice.length} for more._`);
    lines.push(`\n_Use ${P}_get_component to read the source of one component._`);
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: payload };
  });

  // ── get_component ────────────────────────────────────────────────────────
  server.registerTool(`${P}_get_component`, {
    title: 'Get ReactViro Component Source',
    description: `Returns the full TypeScript source of a ReactViro component.

Name matching is case-insensitive and accepts:
  - exact: "ViroBox", "ViroARScene"
  - without Viro prefix: "Box" → finds "ViroBox"
  - with extension: "ViroBox.tsx"

Args:
  - name: Component name (e.g. "ViroBox", "Box", "ARScene")

Returns: full source with category + file path metadata.`,
    inputSchema: z.object({
      name: z.string().min(1),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name }) => {
    const cleaned = name.replace(/\.(tsx|ts|jsx|js)$/i, '').trim();
    const lower = cleaned.toLowerCase();
    const withPrefix = lower.startsWith('viro') || lower.startsWith('studio')
      ? cleaned
      : `Viro${cleaned}`;
    const candidateNames = Array.from(new Set([cleaned, withPrefix]));

    // Walk all component files and find exact basename matches first.
    const { rows } = db.listFiles({ pkg: 'components', limit: 5000, offset: 0 });
    const componentRows: { row: FileRowMeta; basename: string }[] = rows
      .filter(r => r.path.endsWith('.tsx') || r.path.endsWith('.ts'))
      .map(r => ({ row: r, basename: baseNameNoExt(r.path) }))
      .filter(c => isComponentFile(c.basename));

    let match: FileRowMeta | null = null;
    for (const candidate of candidateNames) {
      const exact = componentRows.find(c => c.basename.toLowerCase() === candidate.toLowerCase());
      if (exact) { match = exact.row; break; }
    }
    if (!match) {
      // Substring fallback
      const fuzzy = componentRows.filter(c =>
        candidateNames.some(cand => c.basename.toLowerCase().includes(cand.toLowerCase()))
      );
      if (fuzzy.length === 1) match = fuzzy[0]!.row;
      else if (fuzzy.length > 1) {
        const list = fuzzy.slice(0, 12).map(f => `  - ${f.basename}`).join('\n');
        return { content: [{ type: 'text', text: `Multiple component matches for "${name}":\n${list}\n\nBe more specific.` }] };
      }
    }

    if (!match) {
      const suggestions = componentRows
        .map(c => c.basename)
        .filter(b => b.toLowerCase().includes(cleaned.toLowerCase().slice(0, 3)))
        .slice(0, 8);
      return {
        content: [{ type: 'text', text: `Component "${name}" not found.${suggestions.length ? `\n\nDid you mean: ${suggestions.join(', ')}` : ''}\n\nUse ${P}_list_components to see the full catalog.` }],
      };
    }

    const file = db.getFile(match.path);
    if (!file || file === 'multiple') {
      return { content: [{ type: 'text', text: `Could not read ${match.path}.` }] };
    }

    const componentName = baseNameNoExt(file.path);
    const category = getCategory(componentName);
    const header = `// ${componentName} — ${category}\n// ${file.path}  (${Math.round(file.size / 1024)} KB)\n\n`;
    return {
      content: [{ type: 'text', text: header + file.source }],
      structuredContent: { name: componentName, category, path: file.path, size: file.size },
    };
  });

  // ── list_categories ──────────────────────────────────────────────────────
  server.registerTool(`${P}_list_categories`, {
    title: 'List ReactViro Component Categories',
    description: `Returns the catalog of component categories with counts. Useful as a starting point before drilling into ${P}_list_components.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const { rows } = db.listFiles({ pkg: 'components', limit: 5000, offset: 0 });
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      if (!r.path.endsWith('.tsx') && !r.path.endsWith('.ts')) continue;
      const basename = baseNameNoExt(r.path);
      if (!isComponentFile(basename)) continue;
      const cat = getCategory(basename);
      counts[cat] = (counts[cat] ?? 0) + 1;
      total++;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const lines: string[] = [`# ReactViro — ${total} components in ${sorted.length} categories\n`];
    for (const [cat, n] of sorted) {
      lines.push(`- **${cat}** — ${n} component${n === 1 ? '' : 's'}`);
    }
    lines.push(`\n_Use ${P}_list_components with \`category="..."\` to drill in._`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, categories: Object.fromEntries(sorted) },
    };
  });

  // ── get_platform_matrix ──────────────────────────────────────────────────
  server.registerTool(`${P}_get_platform_matrix`, {
    title: 'ReactViro Platform Compatibility Matrix',
    description: `Returns the curated platform-support matrix for ReactViro features across iOS (ARKit), Android (ARCore), Meta Quest (OpenXR), and Apple visionOS.

Args:
  - platform (optional): Filter to one of "ios" | "android" | "quest" | "visionos". Omit to see the full matrix.
  - response_format: "markdown" (default) | "json"`,
    inputSchema: z.object({
      platform:        z.enum(['ios', 'android', 'quest', 'visionos']).optional(),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
      // `features` and a plural `platforms` were the observed guesses. Neither
      // is a rename: there is no per-feature filter, and `platform` is single.
    }).strict(`Unknown argument. ${P}_get_platform_matrix takes only an optional \`platform\` (one of ios, android, quest, visionos) and \`response_format\`. It has no per-feature or per-component filter: omit \`platform\` to get every feature row on every platform. To check the components a scene uses, call ${P}_check_platform_support with the scene as \`tsx\`.`),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ platform, response_format }) => {
    const matrix = loadPlatformMatrix();
    if (!matrix) {
      return { content: [{ type: 'text', text: 'Platform matrix not found. Expected data/platform-matrix.json.' }] };
    }

    const platforms = platform ? [platform] : matrix.platforms;

    if (response_format === 'json') {
      const features = matrix.features.map(f => ({
        feature: f.feature,
        ...Object.fromEntries(platforms.map(p => [p, !!f.support[p]])),
        notes: f.notes,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ platforms, features }, null, 2) }],
        structuredContent: { platforms, features },
      };
    }

    const lines: string[] = [`# ReactViro — Platform Compatibility\n`];

    if (platforms.length > 1) {
      lines.push(`| Feature | ${platforms.map(p => matrix.platform_labels[p] ?? p).join(' | ')} | Notes |`);
      lines.push(`|---------|${platforms.map(() => ':---:').join('|')}|-------|`);
      for (const f of matrix.features) {
        const cells = platforms.map(p => f.support[p] ? '✅' : '❌').join(' | ');
        lines.push(`| ${f.feature} | ${cells} | ${f.notes} |`);
      }
    } else {
      const p = platforms[0]!;
      lines.push(`## ${matrix.platform_labels[p] ?? p}\n`);
      const supported   = matrix.features.filter(f => f.support[p]);
      const unsupported = matrix.features.filter(f => !f.support[p]);
      lines.push('### ✅ Supported');
      for (const f of supported)   lines.push(`- **${f.feature}**${f.notes ? ` — ${f.notes}` : ''}`);
      lines.push('\n### ❌ Not supported');
      for (const f of unsupported) lines.push(`- ${f.feature}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}

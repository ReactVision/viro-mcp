/**
 * intel.ts — Architecture & intelligence tools.
 *
 * Tools:
 *   - reactviro_get_overview      Entry point for first-time exploration
 *   - reactviro_get_tree          ASCII directory tree (optionally per package)
 *   - reactviro_stats             File counts and sizes by pkg / language
 *   - reactviro_find_symbol       Locate a symbol with definitions vs usages
 *   - reactviro_find_native_bridge  Cross-reference hints for the
 *                                  reactvision-platform MCP (native side)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import type { StarterDb } from '../db.js';

const P = config.toolPrefix;

const SYMBOL_REQUIRED =
  '`symbol` is required: the JS-side prop, event, method or component name to trace, e.g. "onAnchorFound" or "ViroARImageMarker".';

// ─── Tree helpers ─────────────────────────────────────────────────────────────

interface TreeNode { name: string; isFile: boolean; children: Record<string, TreeNode>; }

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '/', isFile: false, children: {} };
  for (const p of paths) {
    const segs = p.split('/');
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      if (!cur.children[s]) {
        cur.children[s] = { name: s, isFile: i === segs.length - 1, children: {} };
      }
      cur = cur.children[s]!;
    }
  }
  return root;
}

function renderTree(node: TreeNode, prefix: string, out: string[]): void {
  const entries = Object.values(node.children).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const last = i === entries.length - 1;
    const branch = last ? '└── ' : '├── ';
    const ext    = last ? '    ' : '│   ';
    out.push(prefix + branch + (e.isFile ? e.name : e.name + '/'));
    if (!e.isFile) renderTree(e, prefix + ext, out);
  }
}

// ─── Bridge hint mapping ──────────────────────────────────────────────────────

/**
 * Heuristic: given a JS-side prop or method name, suggest likely keywords to
 * search in the native side (reactvision-platform MCP). These hints help Claude
 * pivot between MCPs without making this tool actually call the other server.
 */
function bridgeHints(symbol: string): { native_keyword: string; rationale: string }[] {
  const hints: { native_keyword: string; rationale: string }[] = [];

  // Event props (onAnchorFound → ANCHOR_FOUND_EVENT / onAnchorFound)
  if (/^on[A-Z]/.test(symbol)) {
    const evt = symbol.replace(/^on/, '');
    hints.push({
      native_keyword: evt.replace(/[A-Z]/g, m => '_' + m).slice(1).toUpperCase(),
      rationale: `Event handler — look for ${evt.toUpperCase()}_EVENT constant in view managers.`,
    });
    hints.push({
      native_keyword: symbol,
      rationale: `Event handler — also searchable verbatim in the JNI/RCT bridge.`,
    });
  }

  // Material props (lightingModel, shaderModifiers, etc.)
  if (/material|shader|lighting|pbr/i.test(symbol)) {
    hints.push({
      native_keyword: symbol,
      rationale: 'Material/shader prop — likely flows through VROMaterial / shader chunk system.',
    });
  }

  // Physics props
  if (/physics|body|collision/i.test(symbol)) {
    hints.push({
      native_keyword: symbol,
      rationale: 'Physics — Bullet3 wrapper in virocore. Search there for the binding.',
    });
  }

  // Camera / tracking
  if (/anchor|tracking|plane|image.*marker/i.test(symbol)) {
    hints.push({
      native_keyword: symbol,
      rationale: 'AR tracking — ARKit (iOS) / ARCore (Android) integration layer.',
    });
  }

  // Generic fallback
  if (hints.length === 0) {
    hints.push({
      native_keyword: symbol,
      rationale: 'Generic — search verbatim across virocore (C++), viro_bridge (JNI), and iOS bridges.',
    });
  }

  return hints;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerIntelTools(server: McpServer, db: StarterDb): void {

  // ── get_overview ──────────────────────────────────────────────────────────
  server.registerTool(`${P}_get_overview`, {
    title: 'ReactViro Project Overview',
    description: `High-level architecture report — packages indexed, docs available, and the tools to use to drill in. Start here when exploring ReactViro for the first time.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const meta = db.meta();
    const docs = db.listDocs();
    const pkgs = db.db.prepare<[], { pkg: string; n: number; bytes: number }>(`
      SELECT pkg, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
      FROM files GROUP BY pkg ORDER BY pkg
    `).all();

    const ageDays = meta.generated_at
      ? Math.floor((Date.now() - new Date(meta.generated_at).getTime()) / 86_400_000)
      : null;

    const lines: string[] = [
      `# ${config.name} — Overview\n`,
      `**Indexed from:** \`${meta.project}\``,
      `**Generated:**    ${meta.generated_at}${ageDays !== null ? ` (${ageDays}d ago${ageDays > 30 ? ' — ⚠ stale' : ''})` : ''}`,
      `**Files:**        ${meta.file_count} · **Docs:** ${meta.doc_count}\n`,
      `## Packages`,
      ...pkgs.map(p => `- **${p.pkg}** — ${p.n} files · ${(p.bytes / 1024).toFixed(0)} KB`),
      `\n## Description\n${config.projectDescription}\n`,
      `## Available docs (read with ${P}_get_docs)`,
      ...docs.map(d => `- **${d.name}** — \`${d.path}\``),
      `\n## Suggested next tools`,
      `- \`${P}_list_components\` — browse components by category`,
      `- \`${P}_list_categories\` — see the component category breakdown`,
      `- \`${P}_get_platform_matrix\` — iOS/Android/Quest/visionOS support`,
      `- \`${P}_get_tree\` — directory tree per package`,
      `- \`${P}_search\` — FTS5 search across the whole corpus`,
      `- \`${P}_find_symbol\` — locate a function/class/type/const`,
      `- \`${P}_find_native_bridge\` — pivot to the reactvision-platform MCP for native code`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  // ── get_tree ──────────────────────────────────────────────────────────────
  server.registerTool(`${P}_get_tree`, {
    title: 'Directory Tree',
    description: `ASCII directory tree of one or all packages.

Args:
  - pkg (optional): Filter to one package (e.g. "components", "examples", "docs", "infra"). Omit for full tree.
  - max_depth (optional): Limit depth.
  - response_format: "markdown" (default) | "json"`,
    inputSchema: z.object({
      pkg:             z.string().optional(),
      max_depth:       z.number().int().min(1).max(20).optional(),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ pkg, max_depth, response_format }) => {
    const { rows } = db.listFiles({ pkg, limit: 100_000, offset: 0 });
    let paths = rows.map(r => r.path);
    if (max_depth) paths = paths.filter(p => p.split('/').length <= max_depth);

    if (response_format === 'json') {
      return { content: [{ type: 'text', text: JSON.stringify({ pkg: pkg ?? 'all', count: rows.length, paths }, null, 2) }] };
    }

    const tree = buildTree(paths);
    const out: string[] = [];
    renderTree(tree, '', out);

    const header = `# ${config.name} — Tree${pkg ? ` (${pkg})` : ''}\n\n${rows.length} files\n\n\`\`\`\n`;
    return { content: [{ type: 'text', text: header + out.join('\n') + '\n```' }] };
  });

  // ── stats ─────────────────────────────────────────────────────────────────
  server.registerTool(`${P}_stats`, {
    title: 'Codebase Stats',
    description: `File counts and sizes by package and language, plus indexed-at metadata.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const meta = db.meta();
    const rows = db.db.prepare<[], { pkg: string; language: string; n: number; bytes: number }>(`
      SELECT pkg, language, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
      FROM files GROUP BY pkg, language ORDER BY pkg, language
    `).all();

    const byPkg:  Record<string, { n: number; bytes: number }> = {};
    const byLang: Record<string, { n: number; bytes: number }> = {};
    let totalN = 0, totalBytes = 0;
    for (const r of rows) {
      (byPkg[r.pkg]      ??= { n: 0, bytes: 0 }).n += r.n;
      byPkg[r.pkg]!.bytes += r.bytes;
      (byLang[r.language] ??= { n: 0, bytes: 0 }).n += r.n;
      byLang[r.language]!.bytes += r.bytes;
      totalN     += r.n;
      totalBytes += r.bytes;
    }

    const fmt = (b: number): string =>
      b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

    const out: string[] = [
      `# ${config.name} — Stats\n`,
      `**Total:**    ${totalN} files · ${fmt(totalBytes)}`,
      `**Indexed:**  ${meta.generated_at}`,
      `**Project:**  ${meta.project}\n`,
      `## By package`,
    ];
    for (const [k, v] of Object.entries(byPkg).sort()) out.push(`- **${k}** — ${v.n} files · ${fmt(v.bytes)}`);
    out.push(`\n## By language`);
    for (const [k, v] of Object.entries(byLang).sort()) out.push(`- **${k}** — ${v.n} files · ${fmt(v.bytes)}`);
    out.push(`\n## Docs`);
    out.push(`- ${meta.doc_count} docs indexed`);

    return {
      content: [{ type: 'text', text: out.join('\n') }],
      structuredContent: { total: { files: totalN, bytes: totalBytes }, byPkg, byLang },
    };
  });

  // ── find_symbol ───────────────────────────────────────────────────────────
  server.registerTool(`${P}_find_symbol`, {
    title: 'Find Symbol',
    description: `Locates a symbol (function, class, type, interface, const, component) across the codebase. Returns its definition(s) separated from call sites.

Args:
  - name: Symbol name (case-sensitive, matched at word boundaries).
  - pkg (optional): Restrict to one package.
  - limit: Max results (default 60).`,
    inputSchema: z.object({
      name:  z.string().min(1),
      pkg:   z.string().optional(),
      limit: z.number().int().min(1).max(200).default(60),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name, pkg, limit }) => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hits = db.search({ query: `\\b${esc}\\b`, pkg, limit: limit * 2 });
    const defRe = new RegExp(`\\bexport\\s+(?:async\\s+|default\\s+)?(function|class|const|let|var|interface|type|enum|abstract\\s+class)\\s+${esc}\\b`);

    const defs: typeof hits = [];
    const uses: typeof hits = [];
    for (const h of hits) {
      if (defRe.test(h.text)) defs.push(h);
      else uses.push(h);
      if (defs.length + uses.length >= limit) break;
    }

    const lines: string[] = [
      `# Symbol: \`${name}\` — ${defs.length} def${defs.length !== 1 ? 's' : ''} / ${uses.length} use${uses.length !== 1 ? 's' : ''}\n`,
    ];
    if (defs.length > 0) {
      lines.push(`## Definitions\n`);
      for (const d of defs) lines.push(`- **${d.path}**:${d.line} — \`${d.text.slice(0, 160)}\``);
    }
    if (uses.length > 0) {
      lines.push(`\n## Usages\n`);
      for (const u of uses) lines.push(`- **${u.path}**:${u.line} — \`${u.text.slice(0, 160)}\``);
    }
    if (defs.length + uses.length === 0) lines.push(`No matches.`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { name, defs, uses },
    };
  });

  // ── find_native_bridge ────────────────────────────────────────────────────
  server.registerTool(`${P}_find_native_bridge`, {
    title: 'Find Native-side Bridge Hints',
    description: `Given a JS-side prop, event, or method name, suggests what to search for in the **reactvision-platform** MCP (which indexes the native code: virocore C++, viro_bridge JNI, iOS RCT bridges, reactvisioncca SLAM).

This tool does NOT call the native MCP — it returns search hints that you can paste into reactvision_search / reactvision_find_bridge in the platform MCP.

Args:
  - symbol: JS-side prop, event, or method (e.g. "onAnchorFound", "shaderModifiers", "physicsBody")
  - include_js_side (default true): Also include occurrences in the JS-side ReactViro corpus, to confirm where the prop is defined.`,
    inputSchema: z.object({
      symbol:          z.string({ required_error: SYMBOL_REQUIRED }).min(1, SYMBOL_REQUIRED),
      include_js_side: z.boolean().default(true),
    }).strict(`Unknown argument. ${P}_find_native_bridge takes \`symbol\` and optional \`include_js_side\`.`),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ symbol, include_js_side }) => {
    const hints = bridgeHints(symbol);
    const lines: string[] = [
      `# Native bridge hints for \`${symbol}\`\n`,
      `_This MCP only knows the public TypeScript API. To trace the binding all the way down to the render engine, run these in the **reactvision-platform** MCP._\n`,
      `## Suggested search keywords (native side)\n`,
    ];
    for (const h of hints) {
      lines.push(`- **\`${h.native_keyword}\`** — ${h.rationale}`);
    }
    lines.push(`\n## Recommended pivot commands`);
    lines.push('```');
    lines.push(`reactvision_search   query="${hints[0]!.native_keyword}"`);
    lines.push(`reactvision_find_bridge symbol="${symbol}"`);
    lines.push('```');

    if (include_js_side) {
      const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const jsHits = db.search({ query: `\\b${esc}\\b`, limit: 12 });
      lines.push(`\n## JS-side occurrences in @reactvision/react-viro (${jsHits.length})\n`);
      if (jsHits.length === 0) {
        lines.push(`_No matches in the indexed JS corpus. Symbol may live only on the native side._`);
      } else {
        for (const h of jsHits) {
          lines.push(`- **${h.path}**:${h.line} — \`${h.text.slice(0, 160)}\``);
        }
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { symbol, hints },
    };
  });
}

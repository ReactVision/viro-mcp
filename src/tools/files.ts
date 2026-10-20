/**
 * Generic file tools — work for any project.
 * Tool names use config.toolPrefix automatically.
 *
 * Copied verbatim from mcp-starter.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import type { StarterDb } from '../db.js';

const P = config.toolPrefix;

/** 1-based inclusive line slice; null when the range selects nothing. */
export function sliceFileLines(
  source: string,
  start_line?: number,
  end_line?: number,
): { text: string; from: number; to: number; total: number } | null {
  const lines = source.split('\n');
  const from = Math.max(1, start_line ?? 1);
  const to = Math.min(lines.length, end_line ?? lines.length);
  if (from > to) return null;
  return { text: lines.slice(from - 1, to).join('\n'), from, to, total: lines.length };
}

/**
 * `get_file` arguments. The bounds are coerced because `argAliases.ts` rewrites
 * `start`/`startLine` onto them, and an alias is by definition absent from the
 * advertised schema: a client that types arguments from that schema (Claude
 * Code does) sends the value as a string, so a bare `z.number()` would reject
 * the rename it just accepted. The strict message names the bounds because the
 * common wrong guess is `offset`/`limit`, a count rather than a second bound.
 */
export const GET_FILE_ARGS = z.object({
  path:       z.string().min(1),
  start_line: z.coerce.number().int().min(1).optional(),
  end_line:   z.coerce.number().int().min(1).optional(),
}).strict(
  `Unknown argument. ${P}_get_file takes \`path\`, plus optional \`start_line\` and \`end_line\` (1-based, inclusive). To read N lines from a starting point, pass both bounds rather than a count.`,
);

export function registerFileTools(server: McpServer, db: StarterDb): void {

  server.registerTool(`${P}_list_files`, {
    title: `List ${config.name} Files`,
    description: `Lists files in the ${config.name} codebase.

${config.projectDescription}

Args:
  - pkg (string, optional): Filter by package label (see above)
  - language (string, optional): typescript | sql | markdown | config | css | other
  - path (string, optional): Partial path filter
  - limit / offset: Pagination (default limit: 50)
  - response_format: "markdown" | "json"`,
    inputSchema: z.object({
      pkg:             z.string().optional(),
      language:        z.string().optional(),
      path:            z.string().optional(),
      limit:           z.number().int().min(1).max(200).default(50),
      offset:          z.number().int().min(0).default(0),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
      // No `pattern -> path` alias: the observed values were globs, and a glob
      // renamed into `path` matches nothing, so the error would become a
      // silent empty list.
    }).strict(`Unknown argument. ${P}_list_files takes optional \`pkg\`, \`language\` and \`path\`, plus \`limit\`, \`offset\` and \`response_format\`. \`path\` matches a case-insensitive substring of the file path (e.g. \`ImageTarget\`), not a glob, so drop any \`*\`.`),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ pkg, language, path, limit, offset, response_format }) => {
    const { total, rows } = db.listFiles({ pkg, language, path, limit, offset });
    const has_more = total > offset + rows.length;

    if (response_format === 'json') {
      const payload = { total, count: rows.length, offset, has_more,
        ...(has_more ? { next_offset: offset + rows.length } : {}), items: rows };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    }

    const lines: string[] = [`# ${config.name} Files (${total} total)\n`];
    const byPkg: Record<string, typeof rows> = {};
    for (const f of rows) { if (!byPkg[f.pkg]) byPkg[f.pkg] = []; byPkg[f.pkg].push(f); }
    for (const [p, files] of Object.entries(byPkg).sort()) {
      lines.push(`## ${p}`);
      for (const f of files) {
        const s = f.size > 1024 ? `${Math.round(f.size / 1024)} KB` : `${f.size} B`;
        lines.push(`- \`${f.path}\` — ${f.language} · ${s}`);
      }
      lines.push('');
    }
    if (has_more) lines.push(`_Showing ${rows.length} of ${total}. Use offset=${offset + rows.length} for more._`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  server.registerTool(`${P}_get_file`, {
    title: `Get ${config.name} File Source`,
    description: `Returns the source of any file in the ${config.name} project.

Args:
  - path: File path or partial name (case-insensitive). Examples: "ViroBox.tsx", "components/AR", "plane-detection"
  - start_line / end_line (optional): 1-based inclusive range to return only a slice of a large file. Omit both for the full file.`,
    inputSchema: GET_FILE_ARGS,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path, start_line, end_line }) => {
    const result = db.getFile(path);
    if (result === undefined) {
      return { content: [{ type: 'text', text: `File "${path}" not found. Try ${P}_list_files or ${P}_search.` }] };
    }
    if (result === 'multiple') {
      const { rows } = db.listFiles({ path, limit: 10, offset: 0 });
      return { content: [{ type: 'text', text: `Multiple matches for "${path}":\n${rows.map(r => `  - ${r.path}`).join('\n')}\n\nBe more specific.` }] };
    }
    let body = result.source;
    let rangeLine = '';
    if (start_line !== undefined || end_line !== undefined) {
      const slice = sliceFileLines(result.source, start_line, end_line);
      if (slice === null) {
        const total = result.source.split('\n').length;
        return { content: [{ type: 'text', text: `Line range selects nothing: "${result.path}" has ${total} lines.` }] };
      }
      body = slice.text;
      rangeLine = `// lines ${slice.from}-${slice.to} of ${slice.total}\n`;
    }
    const meta = `// ${result.path}\n// pkg: ${result.pkg} | language: ${result.language} | ${Math.round(result.size / 1024)} KB\n${rangeLine}\n`;
    return { content: [{ type: 'text', text: meta + body }] };
  });

  server.registerTool(`${P}_search`, {
    title: `Search ${config.name} Codebase`,
    description: `Searches the ${config.name} codebase using FTS5 + regex fallback. Returns matching lines with file path and line number.

Args:
  - query: Search term or regex pattern. Examples: "onAnchorFound", "shaderModifiers", "physicalWidth"
  - pkg (optional): Limit to one package
  - language (optional): Limit to one language type
  - limit: Max results (default: 40)
  - response_format: "markdown" | "json"`,
    inputSchema: z.object({
      query:           z.string().min(1),
      pkg:             z.string().optional(),
      language:        z.string().optional(),
      limit:           z.number().int().min(1).max(100).default(40),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, pkg, language, limit, response_format }) => {
    const hits = await db.searchFilesHybrid({ query, pkg, language, limit });
    if (hits.length === 0) return { content: [{ type: 'text', text: `No matches for "${query}".` }] };

    if (response_format === 'json') {
      return { content: [{ type: 'text', text: JSON.stringify({ total: hits.length, hits }, null, 2) }], structuredContent: { total: hits.length, hits } };
    }

    const lines: string[] = [`# Search: \`${query}\` — ${hits.length} match${hits.length !== 1 ? 'es' : ''}\n`];
    for (const h of hits) {
      lines.push(`**${h.path}** (line ${h.line})`);
      lines.push('```');
      lines.push(h.text.slice(0, 200));
      lines.push('```\n');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { total: hits.length, hits } };
  });

  server.registerTool(`${P}_get_docs`, {
    title: `Get ${config.name} Documentation`,
    description: `Returns indexed documentation for ${config.name} (README, CHANGELOG, SHADER_REFERENCE, QUEST_SETUP).

Args:
  - name: Doc name or keyword (case-insensitive, partial match). Set list=true to see all available docs.
  - list: If true, lists all docs without returning content.`,
    inputSchema: z.object({
      name: z.string().optional(),
      list: z.boolean().default(false),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name, list }) => {
    if (list || !name) {
      const docs = db.listDocs();
      return { content: [{ type: 'text', text: `# ${config.name} Docs\n\n${docs.map(d => `- **${d.name}** — \`${d.path}\``).join('\n')}` }] };
    }
    const match = db.getDoc(name);
    if (!match) {
      const available = db.listDocs().map(d => d.name).join(', ');
      return { content: [{ type: 'text', text: `Doc "${name}" not found.\nAvailable: ${available}` }] };
    }
    return { content: [{ type: 'text', text: `# ${match.name}\n// ${match.path}\n\n${match.content}` }] };
  });
}

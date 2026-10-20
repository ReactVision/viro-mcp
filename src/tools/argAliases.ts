/**
 * Renames known argument-name synonyms to the canonical parameter on the raw
 * JSON-RPC body, before the SDK validates. Every alias below is a real guess
 * observed as a -32602 in MCP analytics. This runs at the transport seam
 * because the SDK validates before handlers run, and wrapping a tool schema
 * in z.preprocess makes the SDK advertise an empty input schema (its
 * normalizeObjectSchema only recognises plain object schemas).
 */
import { config } from '../../config.js';

const P = config.toolPrefix;

const COMPONENT_NAME = {
  componentName: 'name',
  component_name: 'name',
  component: 'name',
};

/** tool name → { aliasKey: canonicalKey }. Only unambiguous renames belong here. */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  [`${P}_get_component`]: COMPONENT_NAME,
  [`${P}_get_component_props`]: COMPONENT_NAME,
  [`${P}_get_component_events`]: COMPONENT_NAME,
  // The inverse of COMPONENT_NAME: this one really does take `component`, and
  // callers arrive with `name` after being sent here by `_get_usage`.
  [`${P}_examples_using`]: { name: 'component' },
  [`${P}_find_symbol`]: { query: 'name', symbol: 'name' },
  [`${P}_find_native_bridge`]: { query: 'symbol', component: 'symbol' },
  [`${P}_list_examples`]: { pattern: 'search', query: 'search' },
  [`${P}_list_files`]: { query: 'path' },
  // `_get_docs` names a doc; its only other key is `list`, so none of these collides.
  [`${P}_get_docs`]: { topic: 'name', query: 'name', doc: 'name' },
  [`${P}_generate_scene`]: { platform: 'target_platform' },
  [`${P}_validate_scene`]: { source: 'tsx', code: 'tsx', snippet: 'tsx' },
  // The sibling `_get_platform_matrix` really does take a singular `platform`,
  // so this tool's plural is the odd one out and callers reach for the
  // singular. A bare rename is enough only because the schema's `platforms`
  // accepts a lone string as well as an array, so keep the two in step.
  // `code` mirrors `_validate_scene`, the other tool that takes a whole scene.
  [`${P}_check_platform_support`]: { platform: 'platforms', code: 'tsx' },
  // Both casings of both bounds, plus the two path synonyms. `_get_file` is the
  // most-guessed tool in the analytics, which is what a three-argument schema
  // whose arguments are all common words attracts.
  [`${P}_get_file`]: {
    start: 'start_line',
    end: 'end_line',
    startLine: 'start_line',
    endLine: 'end_line',
    file_path: 'path',
    filePath: 'path',
  },
};

/** Mutates `body` (a JSON-RPC message or batch) in place; anything else is left untouched. */
export function applyArgAliases(body: unknown): void {
  if (Array.isArray(body)) {
    for (const message of body) applyToMessage(message);
    return;
  }
  applyToMessage(body);
}

function applyToMessage(message: unknown): void {
  if (typeof message !== 'object' || message === null) return;
  const m = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (m.method !== 'tools/call') return;
  const args = m.params?.arguments;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return;
  const record = args as Record<string, unknown>;
  // Some clients pad a call with a placeholder `random_string`, on tools with
  // optional arguments as well as tools with none. No tool takes it, and every
  // .strict() schema rejects it.
  delete record.random_string;
  const aliases = typeof m.params?.name === 'string' ? ARG_ALIASES[m.params.name] : undefined;
  if (!aliases) return;
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!(alias in record)) continue;
    // When both are present the canonical key wins; the alias is dropped either
    // way so the strict schema doesn't reject it as an unknown key.
    if (!(canonical in record)) record[canonical] = record[alias];
    delete record[alias];
  }
}

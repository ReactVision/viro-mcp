/**
 * scene.ts: scene validation and analysis tools.
 *
 * Tools:
 *   - reactviro_validate_scene         Lint a TSX snippet against the
 *                                      AST-extracted component schemas
 *                                      and the platform-support matrix
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import ts from 'typescript';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../config.js';
import type { StarterDb } from '../db.js';

const P = config.toolPrefix;

const PLATFORM_VALUES = ['ios', 'android', 'quest', 'visionos'] as const;
type Platform = (typeof PLATFORM_VALUES)[number];

// Argument-error text for the two tools whose observed -32602s were a caller
// guessing a name this server cannot honour. A wrong name that is a plain
// rename is repaired at the transport seam (tools/argAliases.ts); `path` and
// `components` are not renames, so the zod message is the only place left to
// say what to send instead. The SDK surfaces these verbatim in the -32602.
const CANNOT_READ_FILES =
  'This server runs remotely and cannot read your filesystem: read the file yourself and pass its contents.';
const TSX_REQUIRED = `Pass the scene source itself as \`tsx\`. ${CANNOT_READ_FILES}`;

interface ExtractedProp { name: string; type: string; optional: boolean; description?: string; since?: string; default?: string }
interface ExtractedEvent { name: string; signature: string; description?: string }

interface PlatformMatrix {
  platforms: string[];
  platform_labels: Record<string, string>;
  features: { feature: string; support: Record<string, boolean>; notes: string }[];
}

interface ComponentFeatureMap {
  components: Record<string, string[]>;
  props:      Record<string, string[]>;
}

// ─── Static data loaders ──────────────────────────────────────────────────────

function dataDir(): string[] {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return [
    join(__dirname, '..', '..', '..', 'data'),
    join(__dirname, '..', '..', 'data'),
  ];
}

function loadJson<T>(name: string): T | null {
  for (const d of dataDir()) {
    const p = join(d, name);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')) as T; } catch { return null; }
    }
  }
  return null;
}

let matrixCache: PlatformMatrix | null = null;
function getMatrix(): PlatformMatrix | null {
  if (!matrixCache) matrixCache = loadJson<PlatformMatrix>('platform-matrix.json');
  return matrixCache;
}

let featureMapCache: ComponentFeatureMap | null = null;
function getFeatureMap(): ComponentFeatureMap {
  if (!featureMapCache) featureMapCache = loadJson<ComponentFeatureMap>('component-features.json') ?? { components: {}, props: {} };
  return featureMapCache;
}

// ─── TSX parsing helpers ──────────────────────────────────────────────────────

function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile('input.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

interface JsxUsage {
  tag:    string;
  line:   number;
  attrs:  { name: string; value: string }[];
  /** Raw text of any spread attributes (we can't validate these). */
  spreads: string[];
}

/** Strips the shared "Viro"/"Studio" prefix so name-similarity comparisons aren't dominated by it. */
export function stripComponentPrefix(name: string): string {
  return name.replace(/^(Viro|Studio)/, '');
}

function getJsxTag(node: ts.JsxOpeningLikeElement): string | null {
  const tn = node.tagName;
  if (ts.isIdentifier(tn)) return tn.text;
  return tn.getText();
}

function walkJsx(source: ts.SourceFile, visit: (u: JsxUsage) => void): void {
  const visitNode = (n: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const tag = getJsxTag(n);
      if (tag) {
        const lineCol = source.getLineAndCharacterOfPosition(n.getStart(source));
        const attrs: JsxUsage['attrs'] = [];
        const spreads: string[] = [];
        for (const a of n.attributes.properties) {
          if (ts.isJsxAttribute(a) && a.name && ts.isIdentifier(a.name)) {
            const value = a.initializer ? a.initializer.getText(source) : '';
            attrs.push({ name: a.name.text, value });
          } else if (ts.isJsxSpreadAttribute(a)) {
            spreads.push(a.expression.getText(source));
          }
        }
        visit({ tag, line: lineCol.line + 1, attrs, spreads });
      }
    }
    ts.forEachChild(n, visitNode);
  };
  ts.forEachChild(source, visitNode);
}

const VIRO_PACKAGE = '@reactvision/react-viro';

/**
 * Names the snippet binds itself: local function/class/variable declarations,
 * and imports from anything other than the Viro package.
 *
 * A `Viro`-prefixed tag resolving to one of these is the caller's own wrapper
 * component, so calling it "unknown" would be wrong. A name imported FROM the
 * Viro package is deliberately not collected — that is exactly the case we do
 * want to check against the real component list.
 */
function locallyBoundNames(source: ts.SourceFile): Set<string> {
  const bound = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (n.moduleSpecifier.text !== VIRO_PACKAGE) {
        const clause = n.importClause;
        if (clause?.name) bound.add(clause.name.text);
        const named = clause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) bound.add(el.name.text);
        } else if (named && ts.isNamespaceImport(named)) {
          bound.add(named.name.text);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
      n.name
    ) {
      bound.add(n.name.text);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      bound.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(source, visit);
  return bound;
}

/**
 * Closest known component to `tag`, compared with the shared Viro/Studio
 * prefix stripped — matching on "viro" would otherwise "suggest" whatever
 * happens to be first in map-iteration order, for any tag at all.
 */
export function suggestComponent(
  tag: string,
  known: Iterable<string>,
): string | undefined {
  const target = stripComponentPrefix(tag).toLowerCase();
  if (target.length < 2) return undefined;
  return [...known].find((n) =>
    stripComponentPrefix(n).toLowerCase().includes(target.slice(0, 4)),
  );
}

export interface UnknownComponent {
  tag: string;
  line: number;
  suggestion?: string;
}

/**
 * `Viro*`/`Studio*` JSX tags in `tsx` that this build has no component for:
 * catches an LLM inventing a plausible-sounding component (`ViroCylinder`,
 * which has never existed on any platform).
 */
export function unknownComponentsIn(tsx: string, db: StarterDb): UnknownComponent[] {
  let source: ts.SourceFile;
  try {
    source = parseTsx(tsx);
  } catch {
    return [];
  }
  const components = buildComponentIndex(db);
  const bound = locallyBoundNames(source);
  const seen = new Set<string>();
  const unknown: UnknownComponent[] = [];

  walkJsx(source, (u) => {
    if (!u.tag.startsWith('Viro') && !u.tag.startsWith('Studio')) return;
    if (components.has(u.tag) || bound.has(u.tag) || seen.has(u.tag)) return;
    seen.add(u.tag);
    const suggestion = suggestComponent(u.tag, components.keys());
    unknown.push({ tag: u.tag, line: u.line, ...(suggestion ? { suggestion } : {}) });
  });

  return unknown;
}

const SCENE_NAVIGATOR_TAGS = ['ViroARSceneNavigator', 'Viro3DSceneNavigator', 'ViroVRSceneNavigator'];

/**
 * `mounted` is the navigator JSX tags in source order; `referenced` is every
 * navigator identifier that appears at all (imports, aliases), the looser test
 * to apply before refusing a scene outright.
 */
export function sceneNavigatorsIn(tsx: string): { mounted: string[]; referenced: Set<string> } {
  const source = parseTsx(tsx);
  const mounted: string[] = [];
  const referenced = new Set<string>();
  walkJsx(source, (u) => { if (SCENE_NAVIGATOR_TAGS.includes(u.tag)) mounted.push(u.tag); });
  const visitNode = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && SCENE_NAVIGATOR_TAGS.includes(n.text)) referenced.add(n.text);
    ts.forEachChild(n, visitNode);
  };
  ts.forEachChild(source, visitNode);
  return { mounted, referenced };
}

function walkRequires(source: ts.SourceFile, visit: (path: string, line: number) => void): void {
  const visitNode = (n: ts.Node): void => {
    if (ts.isCallExpression(n)
        && ts.isIdentifier(n.expression)
        && n.expression.text === 'require'
        && n.arguments.length === 1) {
      const arg = n.arguments[0]!;
      if (ts.isStringLiteralLike(arg)) {
        const lc = source.getLineAndCharacterOfPosition(n.getStart(source));
        visit(arg.text, lc.line + 1);
      }
    }
    ts.forEachChild(n, visitNode);
  };
  ts.forEachChild(source, visitNode);
}

// ─── DB lookup of extracted API ───────────────────────────────────────────────

interface ComponentApi { name: string; props: ExtractedProp[]; events: ExtractedEvent[] }

export function buildComponentIndex(db: StarterDb): Map<string, ComponentApi> {
  const map = new Map<string, ComponentApi>();
  for (const row of db.listApi({ pkg: 'components' })) {
    const basename = (row.path.split('/').pop() ?? row.path).replace(/\.(tsx|ts|jsx|js)$/i, '');
    map.set(basename, {
      name:   basename,
      props:  row.props_json  ? JSON.parse(row.props_json)  as ExtractedProp[]  : [],
      events: row.events_json ? JSON.parse(row.events_json) as ExtractedEvent[] : [],
    });
  }
  return map;
}

// ─── Tool registration ────────────────────────────────────────────────────────

interface SceneAssets {
  local:  { path: string; line: number; kind: string }[];
  remote: { uri: string; line: number }[];
}

/** Static `require('...')` targets and literal `{ uri: '...' }` values. */
function findSceneAssets(source: ts.SourceFile): SceneAssets {
  const local: SceneAssets['local'] = [];
  walkRequires(source, (p, line) => {
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    let kind = 'other';
    if (['glb', 'gltf', 'vrx', 'obj', 'fbx'].includes(ext))      kind = '3D model';
    else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext))        kind = 'texture/image';
    else if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext))          kind = 'audio';
    else if (['mp4', 'mov', 'webm'].includes(ext))                kind = 'video';
    else if (ext === 'json')                                       kind = 'data';
    local.push({ path: p, line, kind });
  });

  const remote: SceneAssets['remote'] = [];
  const visitNode = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const prop of n.properties) {
        if (ts.isPropertyAssignment(prop)
            && ts.isIdentifier(prop.name) && prop.name.text === 'uri'
            && ts.isStringLiteralLike(prop.initializer)) {
          const lc = source.getLineAndCharacterOfPosition(prop.getStart(source));
          remote.push({ uri: prop.initializer.text, line: lc.line + 1 });
        }
      }
    }
    ts.forEachChild(n, visitNode);
  };
  ts.forEachChild(source, visitNode);
  return { local, remote };
}

interface PlatformReport {
  platform:    string;
  unsupported: { feature: string; reasons: { reason: string; line: number }[]; notes: string }[];
}

/** Matrix features the scene's components and props touch, and which targets lack them. Null when the matrix is missing. */
function checkPlatformSupport(
  source: ts.SourceFile,
  platforms: Platform | Platform[] | undefined,
): { features_used: string[]; reports: PlatformReport[]; labels: Record<string, string> } | null {
  const matrix = getMatrix();
  if (!matrix) return null;
  const map = getFeatureMap();

  // Only `undefined` falls back to the full matrix, so an explicit empty
  // array still means "report on nothing".
  const targets: Platform[] =
    platforms === undefined ? (matrix.platforms as Platform[])
    : Array.isArray(platforms) ? platforms
    : [platforms];

  const featuresUsed = new Map<string, { reason: string; line: number }[]>();
  walkJsx(source, (u) => {
    const compFeatures = map.components[u.tag];
    if (compFeatures) {
      for (const f of compFeatures) {
        (featuresUsed.get(f) ?? featuresUsed.set(f, []).get(f))!.push({
          reason: `<${u.tag}>`, line: u.line,
        });
      }
    }
    for (const a of u.attrs) {
      const propFeatures = map.props[a.name];
      if (propFeatures) {
        for (const f of propFeatures) {
          (featuresUsed.get(f) ?? featuresUsed.set(f, []).get(f))!.push({
            reason: `${u.tag}.${a.name}`, line: u.line,
          });
        }
      }
    }
  });

  const reports: PlatformReport[] = targets.map((p) => {
    const unsupported: PlatformReport['unsupported'] = [];
    for (const [feat, reasons] of featuresUsed) {
      const row = matrix.features.find(x => x.feature === feat);
      if (row && !row.support[p]) unsupported.push({ feature: feat, reasons, notes: row.notes });
    }
    return { platform: p, unsupported };
  });
  return { features_used: [...featuresUsed.keys()], reports, labels: matrix.platform_labels };
}

export function registerSceneTools(server: McpServer, db: StarterDb): void {

  // ── validate_scene ────────────────────────────────────────────────────────
  server.registerTool(`${P}_validate_scene`, {
    title: 'Validate a ViroReact Scene Snippet',
    description: `Parses a TSX scene snippet, walks every Viro*/Studio* JSX element, and validates its props/attributes against the AST-extracted component schemas indexed in the KB.

Returns a structured list of issues:
  - unknown_component  (e.g. <ViroBoxen ...> — typo)
  - unknown_prop       (e.g. <ViroBox positoin={...} /> — typo)
  - parse_error        (malformed input)

Note: this is a name-and-shape lint, not a full type checker. Use tsc for type validation.

Also reports which target platforms do not support a component or platform-significant prop the scene uses (e.g. shaderModifiers, physicsBody, morphTargets), checked against the platform support matrix. \`platforms\` narrows that report. To check one component, pass a one-line scene such as \`export default () => <ViroARImageMarker />;\`. To look up a feature by name, read ${P}_get_platform_matrix.

Also lists the assets the scene needs: local files from static \`require('...')\` calls (3D models, textures, sounds, 360 images) that the developer must provide, and remote \`{ uri: '...' }\` URLs.

Input must be TSX source. To validate a Studio scene (JSON), convert it with ${P}_studio_to_tsx first.

Args:
  - tsx: The scene source to validate. Pass the TSX text itself, not a file path.
  - platforms (optional, defaults to all): one of 'ios' | 'android' | 'quest' | 'visionos', or an array of them`,
    inputSchema: z.object({
      tsx: z.string({ required_error: TSX_REQUIRED }).min(1, TSX_REQUIRED),
      // Two separate z.enum instances on purpose: reusing one makes
      // zod-to-json-schema emit the array branch as a $ref back to the first,
      // and an advertised $ref is the kind of indirection that makes a caller
      // guess, which is the whole reason this union exists.
      platforms: z.union([z.enum(PLATFORM_VALUES), z.array(z.enum(PLATFORM_VALUES))]).optional(),
    }).strict(`Unknown argument. ${P}_validate_scene takes \`tsx\` and optional \`platforms\`. ${CANNOT_READ_FILES} To check one component, pass a one-line scene such as \`export default () => <ViroARImageMarker />;\` as \`tsx\`. To look up a feature by name, read ${P}_get_platform_matrix, which lists every feature row.`),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ tsx, platforms }) => {
    interface Issue {
      level:     'error' | 'warning';
      kind:      'unknown_component' | 'unknown_prop' | 'parse_error' | 'spread_skipped';
      component?: string;
      prop?:     string;
      line:      number;
      message:   string;
      suggestion?: string;
    }
    const issues: Issue[] = [];

    let source: ts.SourceFile;
    try { source = parseTsx(tsx); }
    catch (e) {
      return { content: [{ type: 'text', text: `Parse error: ${(e as Error).message}` }] };
    }

    const components = buildComponentIndex(db);
    // Build set of allowed prop names per component (incl. event names)
    const allowedPropsByComponent = new Map<string, Set<string>>();
    for (const [name, api] of components.entries()) {
      const set = new Set<string>();
      for (const p of api.props)  set.add(p.name);
      for (const e of api.events) set.add(e.name);
      allowedPropsByComponent.set(name, set);
    }

    const locallyBound = locallyBoundNames(source);

    walkJsx(source, (u) => {
      if (!u.tag.startsWith('Viro') && !u.tag.startsWith('Studio')) return;

      const api = components.get(u.tag);
      if (!api) {
        // A caller's own `Viro`-prefixed wrapper is not an unknown component.
        if (locallyBound.has(u.tag)) return;
        const suggestion = suggestComponent(u.tag, components.keys());
        issues.push({
          level: 'error', kind: 'unknown_component',
          component: u.tag, line: u.line,
          message: `Unknown component "${u.tag}"`,
          ...(suggestion ? { suggestion: `Did you mean "${suggestion}"?` } : {}),
        });
        return;
      }

      const allowed = allowedPropsByComponent.get(u.tag);
      if (!allowed || allowed.size === 0) return; // no schema → can't validate, skip

      if (u.spreads.length > 0) {
        issues.push({
          level: 'warning', kind: 'spread_skipped',
          component: u.tag, line: u.line,
          message: `Spread attribute(s) on <${u.tag}>; can't validate ${u.spreads.length} prop${u.spreads.length === 1 ? '' : 's'} passed via spread.`,
        });
      }

      for (const a of u.attrs) {
        // Common React intrinsics that aren't in component schemas
        if (a.name === 'key' || a.name === 'ref' || a.name === 'children') continue;
        if (!allowed.has(a.name)) {
          const suggestion = [...allowed].find(p => p.toLowerCase() === a.name.toLowerCase())
            ?? [...allowed].find(p => p.toLowerCase().includes(a.name.toLowerCase().slice(0, 4)));
          issues.push({
            level: 'error', kind: 'unknown_prop',
            component: u.tag, prop: a.name, line: u.line,
            message: `<${u.tag}> has no prop "${a.name}"`,
            ...(suggestion ? { suggestion: `Did you mean "${suggestion}"?` } : {}),
          });
        }
      }
    });

    const errors   = issues.filter(i => i.level === 'error').length;
    const warnings = issues.filter(i => i.level === 'warning').length;

    const lines: string[] = [`# Scene validation — ${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''}\n`];
    if (issues.length === 0) {
      lines.push(`✅ No issues found.`);
    } else {
      for (const i of issues) {
        const icon = i.level === 'error' ? '❌' : '⚠';
        const sug = i.suggestion ? ` — ${i.suggestion}` : '';
        lines.push(`- ${icon} **L${i.line}** [${i.kind}] ${i.message}${sug}`);
      }
    }

    const support = checkPlatformSupport(source, platforms);
    if (support) {
      lines.push(`\n## Platform support\n`);
      if (support.features_used.length === 0) {
        lines.push(`✅ No platform-significant features detected in this scene.`);
      } else if (support.reports.length === 0) {
        lines.push(`No target platforms requested.`);
      } else {
        for (const r of support.reports) {
          const lbl = support.labels[r.platform] ?? r.platform;
          if (r.unsupported.length === 0) {
            lines.push(`- **${lbl}**: ✅ all features supported`);
            continue;
          }
          lines.push(`- **${lbl}**:`);
          for (const u of r.unsupported) {
            lines.push(`  - ❌ **${u.feature}** — used by ${u.reasons.map(x => `\`${x.reason}\` (L${x.line})`).join(', ')}${u.notes ? ` _(note: ${u.notes})_` : ''}`);
          }
        }
      }
    }

    const assets = findSceneAssets(source);
    if (assets.local.length > 0) {
      lines.push(`\n## Local files to provide (\`require(...)\`)\n`);
      for (const a of assets.local) lines.push(`- L${a.line} · _${a.kind}_ — \`${a.path}\``);
    }
    if (assets.remote.length > 0) {
      lines.push(`\n## Remote URIs\n`);
      for (const r of assets.remote) lines.push(`- L${r.line} — \`${r.uri}\``);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        errors, warnings, issues, assets,
        ...(support ? { platform_support: { features_used: support.features_used, reports: support.reports } } : {}),
      },
    };
  });
}

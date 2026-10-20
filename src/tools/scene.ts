/**
 * scene.ts — Scene generation, validation, and analysis tools.
 *
 * Tools:
 *   - reactviro_generate_scene         Ready-to-use TSX scaffold for AR/VR/3D
 *   - reactviro_validate_scene         Lint a TSX snippet against the
 *                                      AST-extracted component schemas
 *   - reactviro_list_assets_needed     Extract require(...) targets from a scene
 *   - reactviro_check_platform_support Cross-reference used components/props
 *                                      against the platform-support matrix
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

// ─── Scene generator (port of v2 reactviro_generate_scene) ────────────────────

type Feature =
  | 'plane-detection' | 'image-tracking' | '3d-model' | 'particles'
  | 'portal' | 'lighting' | 'materials' | 'animations' | 'physics'
  | 'custom-shader' | '360-image' | 'audio' | 'text';

const FEATURE_TO_MATRIX: Record<Feature, string | null> = {
  'plane-detection': 'Plane Detection (horizontal)',
  'image-tracking':  'Image Tracking (ViroARImageMarker)',
  '3d-model':        null,
  'particles':       'Particle Effects',
  'portal':          'Portals (ViroPortalScene)',
  'lighting':        null,
  'materials':       'PBR Materials',
  'animations':      null,
  'physics':         'Physics Engine (Bullet3)',
  'custom-shader':   'Custom Shaders (GLSL)',
  '360-image':       '360° Images',
  'audio':           'Spatial Audio',
  'text':            null,
};

function platformWarnings(features: Feature[], platform: 'ios' | 'android' | 'quest' | 'visionos'): string[] {
  const matrix = getMatrix();
  if (!matrix) return [];
  const warnings: string[] = [];
  for (const f of features) {
    const feat = FEATURE_TO_MATRIX[f];
    if (!feat) continue;
    const row = matrix.features.find(x => x.feature === feat);
    if (row && !row.support[platform]) {
      warnings.push(`⚠ ${f} → "${feat}" is NOT supported on ${platform}${row.notes ? ` (${row.notes})` : ''}`);
    }
  }
  return warnings;
}

// The navigator is always Viro{X}SceneNavigator (Viro3DSceneNavigator,
// ViroARSceneNavigator, ViroVRSceneNavigator all exist), but the scene
// content wrapper is NOT similarly named per-navigator: only ViroARScene is
// real. 3D and VR scenes both use the generic ViroScene — there is no
// Viro3DScene or ViroVRScene component in the package. Getting this wrong
// generated TSX that imported/rendered a component that doesn't exist.
export function sceneComponentName(navigator_type: 'AR' | 'VR' | '3D'): string {
  return navigator_type === 'AR' ? 'ViroARScene' : 'ViroScene';
}

export function generateSceneCode(features: Feature[], navigator_type: 'AR' | 'VR' | '3D'): string {
  const sceneName = sceneComponentName(navigator_type);
  const viroImports = new Set<string>([
    `Viro${navigator_type}SceneNavigator`,
    sceneName,
    'ViroNode',
    'ViroAmbientLight',
  ]);
  const beforeComp: string[] = [];
  const sceneBody:  string[] = [];

  sceneBody.push(`    <ViroAmbientLight color="#FFFFFF" intensity={800} />`);

  if (features.includes('lighting')) {
    viroImports.add('ViroDirectionalLight');
    sceneBody.push(`    <ViroDirectionalLight color="#FFFFFF" direction={[0, -1, -0.5]} castsShadow={true} shadowOpacity={0.5} />`);
  }

  if (features.includes('materials')) {
    viroImports.add('ViroMaterials');
    beforeComp.push(`ViroMaterials.createMaterials({
  myMaterial:   { lightingModel: 'PBR', diffuseColor: '#FFFFFF', metalness: 0.0, roughness: 0.5 },
  glowMaterial: { lightingModel: 'Constant', diffuseColor: '#00FFFF' },
});`);
  }

  if (features.includes('animations')) {
    viroImports.add('ViroAnimations');
    beforeComp.push(`ViroAnimations.registerAnimations({
  rotate:    { properties: { rotateY: '+=360' }, duration: 4000 },
  floatUp:   { properties: { positionY: '+=0.1' }, duration: 1500, easing: 'EaseInEaseOut' },
  floatDown: { properties: { positionY: '-=0.1' }, duration: 1500, easing: 'EaseInEaseOut' },
  float:     { properties: {}, animation: ['floatUp', 'floatDown'], loop: true },
});`);
  }

  if (features.includes('plane-detection')) {
    viroImports.add('ViroARPlaneSelector');
    viroImports.add('ViroBox');
    sceneBody.push(`    <ViroARPlaneSelector>
      <ViroBox
        position={[0, 0, 0]}
        scale={[0.3, 0.3, 0.3]}
        ${features.includes('materials')  ? "materials={['myMaterial']}" : ''}
        ${features.includes('animations') ? "animation={{ name: 'rotate', run: true, loop: true }}" : ''}
      />
    </ViroARPlaneSelector>`);
  }

  if (features.includes('image-tracking')) {
    viroImports.add('ViroARImageMarker');
    viroImports.add('ViroARTrackingTargets');
    viroImports.add('ViroSphere');
    beforeComp.push(`ViroARTrackingTargets.createTargets({
  myTarget: {
    source: require('./assets/my-target.png'),
    orientation: 'Up',
    physicalWidth: 0.2,
  },
});`);
    sceneBody.push(`    <ViroARImageMarker target="myTarget"
      onAnchorFound={() => console.log('Target found!')}
      onAnchorRemoved={() => console.log('Target lost')}>
      <ViroSphere radius={0.05}
        ${features.includes('materials')  ? "materials={['glowMaterial']}" : ''}
        ${features.includes('animations') ? "animation={{ name: 'float', run: true, loop: true }}" : ''}
      />
    </ViroARImageMarker>`);
  }

  if (features.includes('3d-model')) {
    viroImports.add('Viro3DObject');
    sceneBody.push(`    <ViroNode position={[0, -0.5, -1.5]}>
      <Viro3DObject
        source={require('./assets/models/your-model.glb')}
        type="GLB"
        scale={[0.5, 0.5, 0.5]}
        ${features.includes('materials')  ? "materials={['myMaterial']}" : ''}
        ${features.includes('animations') ? "animation={{ name: 'rotate', run: true, loop: true }}" : ''}
        onLoadStart={() => console.log('Loading...')}
        onLoadEnd={() => console.log('Model ready!')}
      />
    </ViroNode>`);
  }

  if (features.includes('particles')) {
    viroImports.add('ViroParticleEmitter');
    if (!features.includes('materials')) {
      viroImports.add('ViroMaterials');
      beforeComp.push(`ViroMaterials.createMaterials({
  fireMaterial: { diffuseColor: '#FF6B35', lightingModel: 'Constant' },
});`);
    }
    sceneBody.push(`    <ViroParticleEmitter
      position={[0, 0, -1]}
      material="fireMaterial"
      image={{ source: require('./assets/particle_fire.png'), height: 0.03, width: 0.03, blendMode: 'Add' }}
      particleLifetime={[1500, 2000]}
      emissionRatePerSecond={[40, 60]}
      maxParticles={200}
    />`);
  }

  if (features.includes('portal')) {
    viroImports.add('ViroPortalScene');
    viroImports.add('ViroPortal');
    viroImports.add('Viro3DObject');
    viroImports.add('Viro360Image');
    sceneBody.push(`    <ViroPortalScene position={[0, 0, -2]} passable={true}
      onPortalEnter={() => console.log('Entered!')}
      onPortalExit={() => console.log('Exited')}>
      <ViroPortal>
        <Viro3DObject source={require('./assets/portals/portal_frame.vrx')} type="VRX" />
      </ViroPortal>
      <Viro360Image source={require('./assets/360/your_360.jpg')} />
    </ViroPortalScene>`);
  }

  if (features.includes('360-image')) {
    viroImports.add('Viro360Image');
    sceneBody.push(`    <Viro360Image source={require('./assets/360/your_360.jpg')} />`);
  }

  if (features.includes('audio')) {
    viroImports.add('ViroSpatialSound');
    sceneBody.push(`    <ViroSpatialSound source={require('./assets/audio/your-sound.mp3')} position={[0, 0, -1]} loop={true} volume={1.0} />`);
  }

  if (features.includes('text')) {
    viroImports.add('ViroText');
    sceneBody.push(`    <ViroText text="Hello, AR!" position={[0, 0.5, -1]} scale={[0.3, 0.3, 0.3]}
      style={{ fontFamily: 'Arial', fontSize: 12, color: '#FFFFFF', textAlignVertical: 'center', textAlign: 'center' }} />`);
  }

  if (features.includes('physics')) {
    viroImports.add('ViroBox');
    viroImports.add('ViroSphere');
    sceneBody.push(`    <ViroBox    position={[0, -0.5, -1]} scale={[1, 0.1, 1]} physicsBody={{ type: 'Static',  mass: 0 }} />
    <ViroSphere position={[0,  0.5, -1]} radius={0.1}        physicsBody={{ type: 'Dynamic', mass: 1, restitution: 0.5, friction: 0.5 }} />`);
  }

  if (features.includes('custom-shader')) {
    viroImports.add('ViroMaterials');
    viroImports.add('ViroSphere');
    beforeComp.push(`ViroMaterials.createMaterials({
  customShader: {
    lightingModel: 'Constant', blendMode: 'Alpha', cullMode: 'None',
    shaderModifiers: {
      surface: {
        uniforms: \`uniform highp float time;\`,
        body: \`
          highp vec2 uv = _surface.diffuse_texcoord;
          highp float t = time * 0.001;
          _surface.diffuse_color = vec4(
            0.5 + 0.5 * sin(uv.x * 10.0 + t),
            0.5 + 0.5 * cos(uv.y * 10.0 + t),
            1.0, 1.0
          );
        \`,
      },
    },
  },
});`);
    sceneBody.push(`    <ViroSphere radius={0.3} position={[0, 0, -1]} materials={['customShader']} />`);
  }

  const importList = [...viroImports].sort().join(',\n  ');
  const navName    = `Viro${navigator_type}SceneNavigator`;
  // sceneName computed once above (sceneComponentName) — reused here.

  return [
    `import React from 'react';`,
    `import { StyleSheet, View } from 'react-native';`,
    `import {\n  ${importList},\n} from '@reactvision/react-viro';`,
    ``,
    beforeComp.length ? `// ─── Setup (runs once at module load) ───────────────────────────────────────` : '',
    ...beforeComp,
    ``,
    `// ─── Scene ───────────────────────────────────────────────────────────────────`,
    `function MyScene(): JSX.Element {`,
    `  return (`,
    `    <${sceneName}>`,
    ...sceneBody,
    `    </${sceneName}>`,
    `  );`,
    `}`,
    ``,
    `// ─── App ─────────────────────────────────────────────────────────────────────`,
    `export default function App(): JSX.Element {`,
    `  return (`,
    `    <View style={styles.container}>`,
    `      <${navName}`,
    `        autofocus={true}`,
    navigator_type === 'AR' ? `        occlusionMode="depthBased"` : '',
    `        initialScene={{ scene: () => <MyScene /> }}`,
    `        style={styles.arView}`,
    `      />`,
    `    </View>`,
    `  );`,
    `}`,
    ``,
    `const styles = StyleSheet.create({`,
    `  container: { flex: 1 },`,
    `  arView:    { flex: 1 },`,
    `});`,
  ].filter(Boolean).join('\n');
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerSceneTools(server: McpServer, db: StarterDb): void {

  // ── generate_scene ────────────────────────────────────────────────────────
  server.registerTool(`${P}_generate_scene`, {
    title: 'Generate ReactViro Scene Template',
    description: `Generates a ready-to-use ReactViro scene template based on the requested features.

This assembles a template from the fixed feature list below. It does not take a free-text description; pick the closest features and adapt the returned TSX.

If \`target_platform\` is provided, the response includes warnings about features that are not supported on that platform (e.g. depth occlusion on Android, custom shaders on Quest).

Args:
  - features: Features to include. Options: "plane-detection", "image-tracking", "3d-model", "particles", "portal", "lighting", "materials", "animations", "physics", "custom-shader", "360-image", "audio", "text"
  - navigator_type: 'AR' | 'VR' | '3D' (default 'AR')
  - target_platform (optional): 'ios' | 'android' | 'quest' | 'visionos' — when set, the response is prefixed with platform compatibility warnings.

Returns: complete TSX scene file with imports, setup, scene component, and navigator.`,
    inputSchema: z.object({
      features: z.array(z.enum([
        'plane-detection', 'image-tracking', '3d-model', 'particles',
        'portal', 'lighting', 'materials', 'animations', 'physics',
        'custom-shader', '360-image', 'audio', 'text',
      ])).min(1),
      navigator_type:  z.enum(['AR', 'VR', '3D']).default('AR'),
      target_platform: z.enum(['ios', 'android', 'quest', 'visionos']).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ features, navigator_type, target_platform }) => {
    const code = generateSceneCode(features, navigator_type);

    let header = `// Generated by ReactViro MCP\n// Features: ${features.join(', ')} · Navigator: ${navigator_type}\n`;
    if (target_platform) {
      header += `// Target platform: ${target_platform}\n`;
      const warns = platformWarnings(features, target_platform);
      if (warns.length > 0) {
        header += `//\n// ⚠ Platform compatibility warnings:\n` + warns.map(w => `//   ${w}`).join('\n') + '\n';
      } else {
        header += `// ✓ All requested features are supported on ${target_platform}.\n`;
      }
    }

    return { content: [{ type: 'text', text: `${header}\n${code}` }] };
  });

  // ── validate_scene ────────────────────────────────────────────────────────
  server.registerTool(`${P}_validate_scene`, {
    title: 'Validate a ReactViro Scene Snippet',
    description: `Parses a TSX scene snippet, walks every Viro*/Studio* JSX element, and validates its props/attributes against the AST-extracted component schemas indexed in the KB.

Returns a structured list of issues:
  - unknown_component  (e.g. <ViroBoxen ...> — typo)
  - unknown_prop       (e.g. <ViroBox positoin={...} /> — typo)
  - parse_error        (malformed input)

Note: this is a name-and-shape lint, not a full type checker. Use tsc for type validation.

Input must be TSX source. To validate a Studio scene (JSON), convert it with ${P}_studio_to_tsx first.

Args:
  - tsx: The scene source to validate. Pass the TSX text itself, not a file path.`,
    inputSchema: z.object({
      tsx: z.string({ required_error: TSX_REQUIRED }).min(1, TSX_REQUIRED),
    }).strict(`Unknown argument. ${P}_validate_scene takes exactly one argument, \`tsx\`. ${CANNOT_READ_FILES}`),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ tsx }) => {
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
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { errors, warnings, issues },
    };
  });

  // ── list_assets_needed ────────────────────────────────────────────────────
  server.registerTool(`${P}_list_assets_needed`, {
    title: 'List Assets Required by a Scene',
    description: `Scans a TSX scene snippet for static \`require('...')\` calls and returns the list of asset paths the developer must provide (3D models, textures, sounds, 360 images, etc.).

Dynamic requires and remote URLs (\`{ uri: '...' }\`) are detected separately.

Args:
  - tsx: The scene source to scan.`,
    inputSchema: z.object({
      tsx: z.string().min(1),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ tsx }) => {
    let source: ts.SourceFile;
    try { source = parseTsx(tsx); }
    catch (e) {
      return { content: [{ type: 'text', text: `Parse error: ${(e as Error).message}` }] };
    }

    const assets: { path: string; line: number; kind: string }[] = [];
    walkRequires(source, (p, line) => {
      const ext = p.split('.').pop()?.toLowerCase() ?? '';
      let kind = 'other';
      if (['glb', 'gltf', 'vrx', 'obj', 'fbx'].includes(ext))      kind = '3D model';
      else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext))        kind = 'texture/image';
      else if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext))          kind = 'audio';
      else if (['mp4', 'mov', 'webm'].includes(ext))                kind = 'video';
      else if (ext === 'json')                                       kind = 'data';
      assets.push({ path: p, line, kind });
    });

    // Detect { uri: '...' } usages (remote)
    const remotes: { uri: string; line: number }[] = [];
    const visitNode = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        for (const prop of n.properties) {
          if (ts.isPropertyAssignment(prop)
              && ts.isIdentifier(prop.name) && prop.name.text === 'uri'
              && ts.isStringLiteralLike(prop.initializer)) {
            const lc = source.getLineAndCharacterOfPosition(prop.getStart(source));
            remotes.push({ uri: prop.initializer.text, line: lc.line + 1 });
          }
        }
      }
      ts.forEachChild(n, visitNode);
    };
    ts.forEachChild(source, visitNode);

    if (assets.length === 0 && remotes.length === 0) {
      return { content: [{ type: 'text', text: 'No required assets detected.' }] };
    }

    const lines: string[] = [`# Required assets — ${assets.length} local + ${remotes.length} remote\n`];
    if (assets.length > 0) {
      lines.push(`## Local files (\`require(...)\`)\n`);
      for (const a of assets) lines.push(`- L${a.line} · _${a.kind}_ — \`${a.path}\``);
    }
    if (remotes.length > 0) {
      lines.push(`\n## Remote URIs\n`);
      for (const r of remotes) lines.push(`- L${r.line} — \`${r.uri}\``);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { local: assets, remote: remotes },
    };
  });

  // ── check_platform_support ────────────────────────────────────────────────
  server.registerTool(`${P}_check_platform_support`, {
    title: 'Check Scene Platform Support',
    description: `Walks a TSX scene, identifies the ReactViro components and platform-significant props (e.g. shaderModifiers, physicsBody, morphTargets), looks each one up in the platform support matrix, and reports unsupported combinations for the requested platforms.

This takes a scene, which can be a single line: to check one component, pass e.g. \`export default () => <ViroARImageMarker />;\`. To look up a feature by name, read ${P}_get_platform_matrix, which lists every feature row and filters only by platform.

Args:
  - tsx: Scene source. Pass the TSX text itself, not a file path.
  - platforms (optional, defaults to all): one of 'ios' | 'android' | 'quest' | 'visionos', or an array of them`,
    inputSchema: z.object({
      tsx: z.string({ required_error: TSX_REQUIRED }).min(1, TSX_REQUIRED),
      // Two separate z.enum instances on purpose: reusing one makes
      // zod-to-json-schema emit the array branch as a $ref back to the first,
      // and an advertised $ref is the kind of indirection that makes a caller
      // guess, which is the whole reason this union exists.
      platforms: z.union([z.enum(PLATFORM_VALUES), z.array(z.enum(PLATFORM_VALUES))]).optional(),
    }).strict(`Unknown argument. ${P}_check_platform_support takes \`tsx\` and optional \`platforms\`. To check one component, pass a one-line scene such as \`export default () => <ViroARImageMarker />;\` as \`tsx\`. To look up a feature by name, read ${P}_get_platform_matrix, which lists every feature row.`),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ tsx, platforms }) => {
    const matrix = getMatrix();
    if (!matrix) return { content: [{ type: 'text', text: 'platform-matrix.json not found.' }] };
    const map = getFeatureMap();

    // Only `undefined` falls back to the full matrix, so an explicit empty
    // array still means "report on nothing", as it did before the union.
    const targets: Platform[] =
      platforms === undefined ? (matrix.platforms as Platform[])
      : Array.isArray(platforms) ? platforms
      : [platforms];

    let source: ts.SourceFile;
    try { source = parseTsx(tsx); }
    catch (e) {
      return { content: [{ type: 'text', text: `Parse error: ${(e as Error).message}` }] };
    }

    // Collect features touched by components and props in the scene
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

    if (featuresUsed.size === 0) {
      return { content: [{ type: 'text', text: '✅ No platform-significant features detected in this scene.' }] };
    }

    interface Report { platform: string; unsupported: { feature: string; reasons: { reason: string; line: number }[]; notes: string }[] }
    const reports: Report[] = [];
    for (const p of targets) {
      const unsupported: Report['unsupported'] = [];
      for (const [feat, reasons] of featuresUsed) {
        const row = matrix.features.find(x => x.feature === feat);
        if (row && !row.support[p]) unsupported.push({ feature: feat, reasons, notes: row.notes });
      }
      reports.push({ platform: p, unsupported });
    }

    const lines: string[] = [`# Platform support report\n`];
    lines.push(`Features touched: ${featuresUsed.size}\n`);
    for (const r of reports) {
      const lbl = matrix.platform_labels[r.platform] ?? r.platform;
      lines.push(`## ${lbl}`);
      if (r.unsupported.length === 0) {
        lines.push(`✅ All features supported.\n`);
      } else {
        for (const u of r.unsupported) {
          lines.push(`- ❌ **${u.feature}** — used by ${u.reasons.map(x => `\`${x.reason}\` (L${x.line})`).join(', ')}${u.notes ? ` _(note: ${u.notes})_` : ''}`);
        }
        lines.push('');
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { features_used: [...featuresUsed.keys()], reports },
    };
  });
}

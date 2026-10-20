import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { generateSceneCode, registerSceneTools, sceneComponentName, sceneNavigatorsIn, stripComponentPrefix, unknownComponentsIn } from '../src/tools/scene.js';
import type { StarterDb } from '../src/db.js';

/** One captured `registerTool` call; the stub server below records these. */
interface RegisteredTool {
  cfg: { inputSchema: z.ZodTypeAny };
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    structuredContent?: { reports: { platform: string }[] };
  }>;
}

// Regression test for a real bug in reactviro_validate_scene's "did you mean"
// suggestion: it compared the first 4 characters of the unknown tag against
// every known name, e.g. "ViroBox".slice(0,4) = "viro" — which every single
// component name contains, since they all share the Viro/Studio prefix. The
// "suggestion" was effectively whatever came first in Map iteration order,
// for ANY unknown tag, not an actual closest match.
describe('stripComponentPrefix', () => {
  it('strips the shared Viro/Studio prefix', () => {
    expect(stripComponentPrefix('ViroBox')).toBe('Box');
    expect(stripComponentPrefix('StudioARScene')).toBe('ARScene');
  });

  it('leaves names without the prefix untouched', () => {
    expect(stripComponentPrefix('SomethingElse')).toBe('SomethingElse');
  });
});

// Regression test for a real bug: the
// generated TSX imported/rendered `Viro{navigator_type}Scene`, which is only
// a real component for AR ("ViroARScene"). 3D and VR have no per-navigator
// scene wrapper — both use the generic "ViroScene" — so the old code
// generated a scene that imported a component that doesn't exist in
// @reactvision/react-viro (Viro3DScene / ViroVRScene).
describe('sceneComponentName', () => {
  it('uses ViroARScene for AR', () => {
    expect(sceneComponentName('AR')).toBe('ViroARScene');
  });

  it('uses the generic ViroScene for 3D (there is no Viro3DScene)', () => {
    expect(sceneComponentName('3D')).toBe('ViroScene');
  });

  it('uses the generic ViroScene for VR (there is no ViroVRScene)', () => {
    expect(sceneComponentName('VR')).toBe('ViroScene');
  });
});

describe('generateSceneCode', () => {
  it('imports and renders ViroScene, not Viro3DScene, for a 3D navigator', () => {
    const code = generateSceneCode(['text'], '3D');
    expect(code).toContain('ViroScene');
    // \b so this doesn't false-positive on the (correct) Viro3DSceneNavigator.
    expect(code).not.toMatch(/\bViro3DScene\b/);
    expect(code).toMatch(/<ViroScene>[\s\S]*<\/ViroScene>/);
  });

  it('imports and renders ViroScene, not ViroVRScene, for a VR navigator', () => {
    const code = generateSceneCode(['text'], 'VR');
    expect(code).toContain('ViroScene');
    // \b so this doesn't false-positive on the (correct) ViroVRSceneNavigator.
    expect(code).not.toMatch(/\bViroVRScene\b/);
    expect(code).toMatch(/<ViroScene>[\s\S]*<\/ViroScene>/);
  });

  it('still uses ViroARScene for an AR navigator', () => {
    const code = generateSceneCode(['text'], 'AR');
    expect(code).toContain('ViroARScene');
    expect(code).toMatch(/<ViroARScene>[\s\S]*<\/ViroARScene>/);
  });

  it('always uses Viro{X}SceneNavigator regardless of the scene wrapper', () => {
    expect(generateSceneCode(['text'], '3D')).toContain('Viro3DSceneNavigator');
    expect(generateSceneCode(['text'], 'VR')).toContain('ViroVRSceneNavigator');
    expect(generateSceneCode(['text'], 'AR')).toContain('ViroARSceneNavigator');
  });
});

// Which navigators a scene mounts, and which it merely references.
describe('sceneNavigatorsIn', () => {
  it('finds the mounted AR navigator and its identifier', () => {
    const r = sceneNavigatorsIn(`
      import { ViroARSceneNavigator } from '@reactvision/react-viro';
      export default () => <ViroARSceneNavigator initialScene={{ scene: Scene }} />;
    `);
    expect(r.mounted).toEqual(['ViroARSceneNavigator']);
    expect(r.referenced.has('ViroARSceneNavigator')).toBe(true);
  });

  it('reports a 3D navigator as mounted with AR absent', () => {
    const r = sceneNavigatorsIn(`
      import { Viro3DSceneNavigator } from '@reactvision/react-viro';
      export default () => <Viro3DSceneNavigator initialScene={{ scene: Scene }} />;
    `);
    expect(r.mounted).toEqual(['Viro3DSceneNavigator']);
    expect(r.referenced.has('ViroARSceneNavigator')).toBe(false);
  });

  it('finds nothing in a scene that only mounts components', () => {
    const r = sceneNavigatorsIn(`
      import { ViroARScene, ViroDirectionalLight } from '@reactvision/react-viro';
      export default () => (
        <ViroARScene><ViroDirectionalLight color="#fff" direction={[0, -1, 0]} /></ViroARScene>
      );
    `);
    expect(r.mounted).toEqual([]);
    expect(r.referenced.size).toBe(0);
  });

  it('counts an aliased navigator as referenced even though the tag differs', () => {
    const r = sceneNavigatorsIn(`
      import { ViroARSceneNavigator } from '@reactvision/react-viro';
      const Nav = ViroARSceneNavigator;
      export default () => <Nav initialScene={{ scene: Scene }} />;
    `);
    expect(r.mounted).toEqual([]);
    expect(r.referenced.has('ViroARSceneNavigator')).toBe(true);
  });
});

// The failure this exists for: an agent wrote <ViroCylinder>, which has never
// existed on any platform. Only this server holds the component index, so only
// it can tell an invented component from a real one.
describe('unknownComponentsIn', () => {
  const db = {
    listApi: () =>
      ['ViroBox', 'ViroSphere', 'ViroGeometry', 'ViroARScene'].map((name) => ({
        path: `components/${name}.tsx`,
        props_json: null,
        events_json: null,
      })),
  } as unknown as Parameters<typeof unknownComponentsIn>[1];

  it('flags a component that does not exist, with the closest real name', () => {
    const found = unknownComponentsIn(
      `import { ViroCylinder } from '@reactvision/react-viro';
       export default () => <ViroCylinder radius={1} />;`,
      db,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.tag).toBe('ViroCylinder');
    expect(found[0]!.line).toBe(2);
  });

  it('says nothing about components that are real', () => {
    expect(
      unknownComponentsIn(
        `export default () => <ViroARScene><ViroBox /><ViroSphere /></ViroARScene>;`,
        db,
      ),
    ).toEqual([]);
  });

  it("leaves the caller's own Viro-prefixed wrapper alone", () => {
    expect(
      unknownComponentsIn(
        `const ViroCard = () => <ViroBox />;
         export default () => <ViroCard />;`,
        db,
      ),
    ).toEqual([]);
  });

  it('ignores tags that are not Viro or Studio components', () => {
    expect(
      unknownComponentsIn(`export default () => <View><Text /></View>;`, db),
    ).toEqual([]);
  });

  it('reports a repeated bad tag once', () => {
    const found = unknownComponentsIn(
      `export default () => <><ViroCylinder /><ViroCylinder /></>;`,
      db,
    );
    expect(found).toHaveLength(1);
  });
});

// The two scene tools whose observed -32602s were a caller guessing an
// argument name. `platform` is a plain rename and is repaired at the
// transport seam (tests/argAliases.test.ts covers that half); these assert
// the half that has to live in the schema, because `path` and `components`
// are not renames of anything this server accepts.
describe('scene tool argument schemas', () => {
  function sceneTools(): Map<string, RegisteredTool> {
    const tools = new Map<string, RegisteredTool>();
    const server = {
      registerTool: (name: string, cfg: RegisteredTool['cfg'], handler: RegisteredTool['handler']) => {
        tools.set(name, { cfg, handler });
      },
    } as unknown as McpServer;
    // registerSceneTools reads the db only from inside handlers, none of which
    // this block drives, so registration needs no real index.
    registerSceneTools(server, {} as StarterDb);
    return tools;
  }

  const tool = (name: string) => {
    const found = sceneTools().get(name);
    if (!found) throw new Error(`${name} was not registered`);
    return found;
  };

  const rejection = (schema: z.ZodTypeAny, args: unknown): string => {
    const result = schema.safeParse(args);
    if (result.success) throw new Error('expected the schema to reject these arguments');
    return result.error.issues.map((i) => i.message).join('\n');
  };

  describe('check_platform_support', () => {
    const schema = () => tool('reactviro_check_platform_support').cfg.inputSchema;

    it('accepts a bare platform string, which is what the `platform` rename produces', () => {
      expect(schema().safeParse({ tsx: '<ViroBox />', platforms: 'quest' }).success).toBe(true);
    });

    it('still accepts an array of platforms', () => {
      expect(schema().safeParse({ tsx: '<ViroBox />', platforms: ['ios', 'quest'] }).success).toBe(true);
    });

    it('still rejects a platform that is not in the matrix', () => {
      expect(schema().safeParse({ tsx: '<ViroBox />', platforms: 'windows' }).success).toBe(false);
    });

    it('points a caller passing `components` at get_platform_matrix', () => {
      const message = rejection(schema(), { components: ['ViroBox'], platforms: ['quest'] });
      expect(message).toContain('reactviro_get_platform_matrix');
    });

    it('reports on only the named platform when given a bare string', async () => {
      const { cfg, handler } = tool('reactviro_check_platform_support');
      const args = cfg.inputSchema.parse({
        tsx: 'export default () => <ViroPortalScene />;',
        platforms: 'quest',
      });
      const result = await handler(args as Record<string, unknown>);
      expect(result.structuredContent?.reports.map((r) => r.platform)).toEqual(['quest']);
    });

    it('defaults to every platform when none is given', async () => {
      const { cfg, handler } = tool('reactviro_check_platform_support');
      const args = cfg.inputSchema.parse({ tsx: 'export default () => <ViroPortalScene />;' });
      const result = await handler(args as Record<string, unknown>);
      expect(result.structuredContent?.reports.map((r) => r.platform)).toEqual([
        'ios', 'android', 'quest', 'visionos',
      ]);
    });
  });

  describe('validate_scene', () => {
    const schema = () => tool('reactviro_validate_scene').cfg.inputSchema;

    it('tells a caller passing `path` that the server cannot read files', () => {
      const message = rejection(schema(), { path: '/Users/me/Scene.tsx' });
      expect(message).toContain('cannot read your filesystem');
    });

    it('says the same when tsx is simply missing', () => {
      expect(rejection(schema(), {})).toContain('cannot read your filesystem');
    });

    it('still accepts a plain tsx string', () => {
      expect(schema().safeParse({ tsx: '<ViroBox />' }).success).toBe(true);
    });
  });
});

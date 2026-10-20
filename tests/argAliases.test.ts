/**
 * Tests for the transport-level argument alias rewrite (src/tools/argAliases.ts).
 */
import { describe, it, expect } from 'vitest';
import { applyArgAliases } from '../src/tools/argAliases.js';

function toolCall(name: string, args: unknown) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
}

describe('applyArgAliases', () => {
  it('renames componentName to name for get_component', () => {
    const body = toolCall('reactviro_get_component', { componentName: 'ViroBox' });
    applyArgAliases(body);
    expect(body.params.arguments).toEqual({ name: 'ViroBox' });
  });

  it('renames the observed synonyms on each aliased tool', () => {
    const cases: [string, object, object][] = [
      ['reactviro_get_component_props', { component: 'ViroBox' }, { name: 'ViroBox' }],
      ['reactviro_find_symbol', { query: 'onAnchorFound' }, { name: 'onAnchorFound' }],
      ['reactviro_list_examples', { pattern: 'portal' }, { search: 'portal' }],
      ['reactviro_list_files', { query: 'components/AR' }, { path: 'components/AR' }],
      ['reactviro_generate_scene', { features: ['text'], platform: 'quest' }, { features: ['text'], target_platform: 'quest' }],
      ['reactviro_validate_scene', { source: '<ViroBox />' }, { tsx: '<ViroBox />' }],
      ['reactviro_check_platform_support', { tsx: '<ViroBox />', platform: 'quest' }, { tsx: '<ViroBox />', platforms: 'quest' }],
      ['reactviro_get_file', { path: 'ViroBox.tsx', start: 1, end: 40 }, { path: 'ViroBox.tsx', start_line: 1, end_line: 40 }],
      // Observed 2026-08-14 .. 2026-09-14; every case below is a real -32602.
      ['reactviro_get_component', { component_name: 'ViroBox' }, { name: 'ViroBox' }],
      ['reactviro_get_file', { file_path: 'ViroBox.tsx' }, { path: 'ViroBox.tsx' }],
      ['reactviro_get_file', { filePath: 'ViroBox.tsx' }, { path: 'ViroBox.tsx' }],
      ['reactviro_get_file', { path: 'ViroBox.tsx', startLine: 1, endLine: 40 }, { path: 'ViroBox.tsx', start_line: 1, end_line: 40 }],
      ['reactviro_find_native_bridge', { query: 'setNativeProps' }, { symbol: 'setNativeProps' }],
      // Observed 2026-09-26.
      ['reactviro_find_native_bridge', { component: 'ViroARImageMarker' }, { symbol: 'ViroARImageMarker' }],
      ['reactviro_get_docs', { topic: 'plane-detection' }, { name: 'plane-detection' }],
      ['reactviro_get_docs', { query: 'plane-detection' }, { name: 'plane-detection' }],
      ['reactviro_check_platform_support', { code: '<ViroBox />' }, { tsx: '<ViroBox />' }],
      // Observed 2026-09-15: `_get_usage` redirects a component lookup here,
      // and the caller carries `name` over from the sibling component tools.
      ['reactviro_examples_using', { name: 'ViroParticleEmitter' }, { component: 'ViroParticleEmitter' }],
      // Observed 2026-09-21.
      ['reactviro_get_docs', { doc: 'plane-detection' }, { name: 'plane-detection' }],
    ];
    for (const [tool, args, expected] of cases) {
      const body = toolCall(tool, args);
      applyArgAliases(body);
      expect(body.params.arguments, tool).toEqual(expected);
    }
  });

  it('drops the alias but keeps the canonical value when both are present', () => {
    const body = toolCall('reactviro_get_component', { name: 'ViroText', componentName: 'ViroBox' });
    applyArgAliases(body);
    expect(body.params.arguments).toEqual({ name: 'ViroText' });
  });

  it('drops the random_string placeholder on every tool', () => {
    const cases: [string, object, object][] = [
      // Observed 2026-09: a tool whose arguments are all optional.
      ['reactviro_get_platform_matrix', { random_string: 'dummy' }, {}],
      ['reactviro_list_categories', { random_string: '' }, {}],
      ['reactviro_get_component', { componentName: 'ViroBox', random_string: 'x' }, { name: 'ViroBox' }],
    ];
    for (const [tool, args, expected] of cases) {
      const body = toolCall(tool, args);
      applyArgAliases(body);
      expect(body.params.arguments, tool).toEqual(expected);
    }
  });

  it('handles JSON-RPC batches', () => {
    const a = toolCall('reactviro_find_symbol', { query: 'x' });
    const b = toolCall('reactviro_get_component', { componentName: 'ViroBox' });
    applyArgAliases([a, b]);
    expect(a.params.arguments).toEqual({ name: 'x' });
    expect(b.params.arguments).toEqual({ name: 'ViroBox' });
  });

  it('leaves non-tool-call messages, unknown tools, and non-object arguments alone', () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { name: 'reactviro_get_component', arguments: { componentName: 'x' } } };
    applyArgAliases(list);
    expect(list.params.arguments).toEqual({ componentName: 'x' });

    const unknown = toolCall('reactviro_get_docs', { componentName: 'x' });
    applyArgAliases(unknown);
    expect(unknown.params.arguments).toEqual({ componentName: 'x' });

    const nonObject = toolCall('reactviro_get_component', 'componentName=x');
    applyArgAliases(nonObject);
    expect(nonObject.params.arguments).toBe('componentName=x');

    expect(() => applyArgAliases(null)).not.toThrow();
    expect(() => applyArgAliases({ method: 'tools/call' })).not.toThrow();
  });
});

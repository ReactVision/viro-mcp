/**
 * Tests for reactviro_list_examples' `component` filter (src/tools/examples.ts),
 * driven through a stub server and a stub index.
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { registerExamplesTools } from '../src/tools/examples.js';
import type { StarterDb } from '../src/db.js';

interface RegisteredTool {
  cfg: { inputSchema: z.ZodTypeAny };
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    structuredContent?: {
      total: number;
      component?: string;
      examples: { name: string; lines?: { line: number; text: string }[] }[];
    };
  }>;
}

const FILES: Record<string, string> = {
  'ar-examples/Portal.tsx': 'import { ViroPortalScene } from "x";\n<ViroPortalScene>\n</ViroPortalScene>',
  'ar-examples/Sparks.tsx': '<ViroParticleEmitter />',
  'ar-examples/Mixed.tsx': '<ViroPortalScene />\n<ViroBox />',
};

const db = {
  listFiles: () => ({
    total: Object.keys(FILES).length,
    rows: Object.entries(FILES).map(([path, source]) => ({ path, size: source.length })),
  }),
  search: ({ query }: { query: string }) => {
    const re = new RegExp(query, 'i');
    return Object.entries(FILES).flatMap(([path, source]) =>
      source.split('\n').flatMap((text, i) => (re.test(text) ? [{ path, line: i + 1, text }] : [])),
    );
  },
} as unknown as StarterDb;

function listExamples(): RegisteredTool {
  let found: RegisteredTool | undefined;
  const server = {
    registerTool: (name: string, cfg: RegisteredTool['cfg'], handler: RegisteredTool['handler']) => {
      if (name === 'reactviro_list_examples') found = { cfg, handler };
    },
  } as unknown as McpServer;
  registerExamplesTools(server, db);
  if (!found) throw new Error('reactviro_list_examples was not registered');
  return found;
}

const run = async (args: Record<string, unknown>) => {
  const { cfg, handler } = listExamples();
  return handler(cfg.inputSchema.parse(args) as Record<string, unknown>);
};

describe('list_examples component', () => {
  it('returns only the examples using the component, most occurrences first', async () => {
    const result = await run({ component: 'PortalScene', response_format: 'json' });
    expect(result.structuredContent?.component).toBe('ViroPortalScene');
    expect(result.structuredContent?.examples.map((e) => e.name)).toEqual(['Portal', 'Mixed']);
    expect(result.structuredContent?.examples[0]?.lines).toHaveLength(3);
  });

  it('prints up to three matching lines per example', async () => {
    const result = await run({ component: 'ViroPortalScene' });
    const text = result.content[0]!.text;
    expect(text).toContain('using `ViroPortalScene`');
    expect(text).toContain('L2: `<ViroPortalScene>`');
    expect(text).not.toContain('Sparks');
  });

  it('combines with search', async () => {
    const result = await run({ component: 'ViroPortalScene', search: 'mix', response_format: 'json' });
    expect(result.structuredContent?.examples.map((e) => e.name)).toEqual(['Mixed']);
  });

  it('says so when no example uses the component', async () => {
    const result = await run({ component: 'ViroSpinner' });
    expect(result.content[0]!.text).toBe('No examples found using `ViroSpinner`.');
  });
});

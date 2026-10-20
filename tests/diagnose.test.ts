/**
 * Tests for reactviro_diagnose_error's pure logic (src/tools/diagnose.ts):
 * matching real curated traps by symptom text, and the token-extraction
 * heuristic that feeds the doc-search fallback. Same pattern as
 * usage-tool.test.ts / scene.test.ts — test the exported pure functions
 * directly rather than going through McpServer's tool registry.
 */
import { describe, expect, it } from 'vitest';
import { extractSearchTerms, loadTraps, matchTraps, respond } from '../src/tools/diagnose.js';

describe('loadTraps', () => {
  it('loads the curated known-traps.json', () => {
    const traps = loadTraps();
    expect(traps.length).toBeGreaterThan(0);
    expect(traps.map((t) => t.id)).toContain('nonexistent-per-navigator-scene');
  });
});

describe('matchTraps', () => {
  const traps = loadTraps();

  it('matches the Viro3DScene trap by symptom text', () => {
    const matches = matchTraps(
      'Error: Element type is invalid: expected a string (for built-in components) or a class/function... Component: Viro3DScene',
      traps,
    );
    expect(matches.map((m) => m.trap.id)).toContain('nonexistent-per-navigator-scene');
  });

  it('matches the onClick native crash trap', () => {
    const matches = matchTraps("-[VRTBox setOnClick:]: unrecognized selector sent to instance 0x1234", traps);
    expect(matches.map((m) => m.trap.id)).toContain('onclick-prop-leak');
  });

  it('matches the useState-updater trap', () => {
    const matches = matchTraps(
      'Did you accidentally export a JSX literal instead of a component?\nCheck the render method of `TsxRoot`.',
      traps,
    );
    expect(matches.map((m) => m.trap.id)).toContain('usestate-function-as-updater');
  });

  it('matches the Vite require() trap', () => {
    const matches = matchTraps('Uncaught ReferenceError: require is not defined', traps);
    expect(matches.map((m) => m.trap.id)).toContain('vite-require-in-web-component');
  });

  it('ranks a trap matching more symptom strings above one matching fewer', () => {
    // "Element type is invalid" + "Viro3DScene" both hit the same trap —
    // it should outrank anything matching only one generic phrase.
    const matches = matchTraps('Element type is invalid: ... Viro3DScene', traps);
    expect(matches[0]?.trap.id).toBe('nonexistent-per-navigator-scene');
    expect(matches[0]?.matchedSymptoms.length).toBeGreaterThanOrEqual(2);
  });

  it('returns no matches for unrelated text', () => {
    expect(matchTraps('completely unrelated network timeout', traps)).toEqual([]);
  });
});

describe('extractSearchTerms', () => {
  it('drops common stopwords and short tokens', () => {
    const terms = extractSearchTerms('TypeError: undefined is not a function at MyComponent (foo.js:12)', 8);
    expect(terms).not.toMatch(/\bTypeError\b/);
    expect(terms).not.toMatch(/\bundefined\b/);
    expect(terms).toContain('MyComponent');
  });

  it('dedupes and caps at the given limit', () => {
    const terms = extractSearchTerms('AAAA AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH', 3);
    expect(terms.split(' ')).toEqual(['AAAA', 'BBBB', 'CCCC']);
  });

  it('returns an empty string for text with no usable tokens', () => {
    expect(extractSearchTerms('!!! ??? ...', 8)).toBe('');
  });
});

// Regression coverage for the response_format convention (CLAUDE.md: "support
// a response_format: 'markdown' | 'json' arg... where output is non-trivial")
// diagnose_error was missing entirely until this fix.
describe('respond', () => {
  const structured = { matched: true, traps: ['x'] };

  it('renders the markdown text for response_format "markdown"', () => {
    const result = respond('markdown', structured, '# some markdown');
    expect(result.content).toEqual([{ type: 'text', text: '# some markdown' }]);
    expect(result.structuredContent).toBe(structured);
  });

  it('renders structuredContent as the text for response_format "json"', () => {
    const result = respond('json', structured, '# some markdown');
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(structured, null, 2) }]);
    expect(result.structuredContent).toBe(structured);
  });
});

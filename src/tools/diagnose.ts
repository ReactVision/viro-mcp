/**
 * diagnose.ts — reactviro_diagnose_error.
 *
 * Matches a caller-supplied error message/stack trace against curated
 * "known traps" (data/known-traps.json — symptom -> cause -> fix, edited by
 * hand, same pattern as ar-domain.json/platform-matrix.json) and falls back
 * to a full-text search of the indexed docs/changelog for anything the
 * curated list doesn't cover. Read-only: no code execution, just lookups.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../config.js';
import type { StarterDb } from '../db.js';

const P = config.toolPrefix;

interface KnownTrap {
  id: string;
  title: string;
  symptoms: string[];
  explanation: string;
  fix: string;
  affects: string[];
  source: string;
}

interface KnownTrapsFile {
  traps: KnownTrap[];
}

let trapsCache: KnownTrap[] | null = null;
export function loadTraps(): KnownTrap[] {
  if (trapsCache) return trapsCache;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, '..', '..', '..', 'data', 'known-traps.json'),
    join(__dirname, '..', '..', 'data', 'known-traps.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        trapsCache = (JSON.parse(readFileSync(p, 'utf-8')) as KnownTrapsFile).traps;
        return trapsCache;
      } catch { /* fall through */ }
    }
  }
  trapsCache = [];
  return trapsCache;
}

export interface TrapMatch { trap: KnownTrap; matchedSymptoms: string[] }

export function matchTraps(errorText: string, traps: KnownTrap[]): TrapMatch[] {
  const lower = errorText.toLowerCase();
  const matches: TrapMatch[] = [];
  for (const trap of traps) {
    const matchedSymptoms = trap.symptoms.filter((s) => lower.includes(s.toLowerCase()));
    if (matchedSymptoms.length > 0) matches.push({ trap, matchedSymptoms });
  }
  // Most-matched-symptoms first — a trap matching 2 of its symptom strings
  // is a more specific hit than one matching only its most generic one.
  return matches.sort((a, b) => b.matchedSymptoms.length - a.matchedSymptoms.length);
}

// Pull a handful of distinctive tokens out of a raw error/stack trace for the
// doc-search fallback — searching the whole trace verbatim would mostly hit
// noise (file paths, line numbers, generic JS frames).
export function extractSearchTerms(errorText: string, limit: number): string {
  const words = errorText.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
  const stop = new Set(['Error', 'TypeError', 'ReferenceError', 'undefined', 'null', 'this', 'that', 'function', 'object', 'Object']);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const w of words) {
    if (stop.has(w) || seen.has(w)) continue;
    seen.add(w);
    terms.push(w);
    if (terms.length >= limit) break;
  }
  return terms.join(' ');
}

/** response_format: 'json' returns the same structuredContent as the sole content block, instead of the markdown rendering. */
export function respond(responseFormat: 'markdown' | 'json', structuredContent: Record<string, unknown>, markdownText: string) {
  return {
    content: [{
      type: 'text' as const,
      text: responseFormat === 'json' ? JSON.stringify(structuredContent, null, 2) : markdownText,
    }],
    structuredContent,
  };
}

export function registerDiagnoseTools(server: McpServer, db: StarterDb): void {
  server.registerTool(`${P}_diagnose_error`, {
    title: 'Diagnose a ReactViro Error or Crash',
    description: `Matches a runtime error, exception or crash log against curated known traps — symptom, root cause and fix for issues that are easy to hit and hard to diagnose from the message alone, such as a native crash with no JS logs.

Falls back to a full-text search of the indexed docs/changelog when nothing in the curated list matches, so you still get something even for errors that aren't (yet) a documented trap.

This is a starting point, not a certainty: a match means the symptom text overlaps a known issue, not that it's confirmed to be the same root cause in your case — check the explanation against what you're actually seeing.

Args:
  - error_text: the error message, exception, or crash log to diagnose.
  - response_format: "markdown" (default) | "json"`,
    inputSchema: z.object({
      error_text: z.string().min(1),
      response_format: z.enum(['markdown', 'json']).default('markdown'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ error_text, response_format }) => {
    const traps = loadTraps();
    const matches = matchTraps(error_text, traps);

    if (matches.length > 0) {
      const lines: string[] = [`# ${matches.length} known trap${matches.length === 1 ? '' : 's'} matched\n`];
      for (const { trap, matchedSymptoms } of matches) {
        lines.push(`## ${trap.title}`);
        lines.push(`Matched: ${matchedSymptoms.map((s) => `"${s}"`).join(', ')}`);
        lines.push(`\n**What's happening:** ${trap.explanation}`);
        lines.push(`\n**Fix:** ${trap.fix}`);
        lines.push(`\n_Affects: ${trap.affects.join(', ')} · Source: ${trap.source}_\n`);
      }
      return respond(response_format, {
        matched: true,
        traps: matches.map((m) => ({ id: m.trap.id, title: m.trap.title, matched_symptoms: m.matchedSymptoms })),
      }, lines.join('\n'));
    }

    // No curated trap — fall back to a doc/changelog search on distinctive
    // tokens pulled from the error text.
    const searchTerms = extractSearchTerms(error_text, 8);
    const hits = searchTerms ? db.search({ query: searchTerms, limit: 8 }) : [];

    if (hits.length === 0) {
      return respond(
        response_format,
        { matched: false, traps: [], search_hits: [] },
        `No known trap matched, and nothing relevant found in the indexed docs/changelog for: "${searchTerms || error_text.slice(0, 80)}".\n\nThis might be a new issue — ${P}_search / ${P}_get_docs can dig further, or ${P}_validate_scene / ${P}_render_scene if this came from a generated scene.`,
      );
    }

    const lines: string[] = [
      `# No known trap matched — ${hits.length} related mention${hits.length === 1 ? '' : 's'} in docs/changelog\n`,
      `Searched for: ${searchTerms}\n`,
    ];
    for (const h of hits) {
      lines.push(`- **${h.path}:${h.line}** (${h.pkg}) — \`${h.text}\``);
    }
    return respond(response_format, { matched: false, traps: [], search_hits: hits }, lines.join('\n'));
  });
}

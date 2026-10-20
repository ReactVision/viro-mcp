/**
 * custom.ts — Composition entry point for the ViroReact knowledge tools.
 *
 * Each module registers its own slice of the tool surface; this file just
 * wires them up so src/index.ts stays clean. Every tool here is read-only and
 * answers from the indexed knowledge base or the curated data/ files.
 *
 * Tool groups:
 *   - components.ts   list/get components, categories, platform matrix
 *   - intel.ts        overview, tree, stats, find_symbol, native bridge
 *   - api.ts          AST-extracted props/events
 *   - examples.ts     showcase explorer
 *   - scene.ts        generate, validate, list_assets_needed, check_platform_support
 *   - domain.ts       lighting models, physics, shaders, easings, changelog
 *   - diagnose.ts     error/stack-trace -> known-issue lookup
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StarterDb } from '../db.js';
import { registerComponentTools } from './components.js';
import { registerIntelTools }     from './intel.js';
import { registerApiTools }       from './api.js';
import { registerExamplesTools }  from './examples.js';
import { registerSceneTools }     from './scene.js';
import { registerDomainTools }    from './domain.js';
import { registerDiagnoseTools }  from './diagnose.js';

export function registerCustomTools(server: McpServer, db: StarterDb): void {
  registerComponentTools(server, db);
  registerIntelTools(server, db);
  registerApiTools(server, db);
  registerExamplesTools(server, db);
  registerSceneTools(server, db);
  registerDomainTools(server, db);
  registerDiagnoseTools(server, db);
}

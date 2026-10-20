#!/usr/bin/env tsx
/**
 * reactviro-mcp-server — Generic Indexer (SQLite + FTS5)
 *
 * Reads config.ts and walks the specified directories.
 * No project-specific logic here — everything comes from config.
 *
 * Run: npm run index
 * Output: knowledge/<config.dbName>
 *
 * Copied from mcp-starter.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, relative, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { extractApi, extractNamedType, type ExtractedProp, type ExtractedEvent } from './ast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_DIR  = join(__dirname, '..', 'knowledge');
const DB_PATH = join(KB_DIR, config.dbName);

// ─── Language detection ───────────────────────────────────────────────────────

function getLanguage(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const base = filename.toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext))               return 'typescript';
  if (['.py'].includes(ext))                                       return 'python';
  if (['.go'].includes(ext))                                       return 'go';
  if (['.rb'].includes(ext))                                       return 'ruby';
  if (['.rs'].includes(ext))                                       return 'rust';
  if (['.java', '.kt', '.swift'].includes(ext))                    return 'jvm';
  if (['.sql', '.graphql', '.proto'].includes(ext))                return 'sql';
  if (['.md'].includes(ext))                                       return 'markdown';
  if (['.css', '.scss', '.sass'].includes(ext))                    return 'css';
  if (['.glsl', '.vert', '.frag'].includes(ext))                   return 'glsl';
  if (['.json', '.toml', '.yaml', '.yml', '.conf'].includes(ext))  return 'config';
  if (base === 'dockerfile' || base.startsWith('.env'))            return 'config';
  return 'other';
}

// ─── Walker ───────────────────────────────────────────────────────────────────

interface FileRow {
  path: string;
  pkg: string;
  language: string;
  size: number;
  source: string;
  props_json: string | null;
  events_json: string | null;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

interface CommonApi { props: ExtractedProp[]; events: ExtractedEvent[] }

/**
 * ViroBaseProps (= ViroCommonProps & ViroObjectProps, from
 * components/AR/ViroCommonProps.ts) is what every `class X extends
 * ViroBase<T>` actually renders as its props, via ViroBase's own heritage
 * (`extends React.Component<ViroBaseProps & T>`) -- not via `interface`
 * inheritance, which is the only kind ast.ts's per-file extraction resolves
 * on its own. Resolved once, up front, and merged into every ViroBase
 * subclass's own extraction (see ast.ts's extractApi `common` parameter).
 * Without this, position/scale/rotation/materials/onClick/etc. -- declared
 * once here instead of on every component -- are invisible to
 * reactviro_validate_scene and reactviro_get_component_props for every
 * single component, and a component with no OWN props (e.g. ViroBox,
 * ViroNode: `extends ViroBase<{}>`) has no extracted API at all and is
 * reported as an unknown component.
 */
async function resolveCommonApi(componentsRoot: string): Promise<CommonApi | null> {
  const path = join(componentsRoot, 'AR', 'ViroCommonProps.ts');
  if (!(await exists(path))) {
    console.warn(`  ⚠ AR/ViroCommonProps.ts not found under ${componentsRoot} -- every component's schema will be missing its common props.`);
    return null;
  }
  const source = await readFile(path, 'utf-8');
  const common = extractNamedType(source, 'ViroCommonProps.ts', 'ViroCommonProps');
  const object = extractNamedType(source, 'ViroCommonProps.ts', 'ViroObjectProps');
  if (!common && !object) return null;
  const props  = [...(common?.props ?? []),  ...(object?.props ?? [])];
  const events = [...(common?.events ?? []), ...(object?.events ?? [])];
  // Both types independently re-declare a few names (renderingOrder, visible,
  // opacity, onCollision) -- dedupe rather than emit the same prop twice.
  const dedupe = <T extends { name: string }>(xs: T[]): T[] => [...new Map(xs.map(x => [x.name, x])).values()];
  return { props: dedupe(props), events: dedupe(events) };
}

async function walkDir(
  dir: string,
  pkg: string,
  projectRoot: string,
  skipExtra: Set<string>,
  results: FileRow[],
  commonApi: CommonApi | null,
): Promise<void> {
  let items: string[];
  try { items = await readdir(dir); } catch { return; }

  for (const item of items) {
    const full = join(dir, item);
    const ext  = extname(item).toLowerCase();
    const base = item.toLowerCase();

    let info: Awaited<ReturnType<typeof stat>>;
    try { info = await stat(full); } catch { continue; }

    if (info.isDirectory()) {
      if (config.globalSkipDirs.has(item) || skipExtra.has(item) || item.startsWith('.')) continue;
      await walkDir(full, pkg, projectRoot, skipExtra, results, commonApi);
      continue;
    }

    if (config.skipExts.has(ext)) continue;

    const shouldIndex = config.sourceExts.has(ext) || config.sourceExts.has(base);
    if (!shouldIndex) continue;

    const relPath = relative(projectRoot, full);
    const language = getLanguage(item);

    try {
      const source = await readFile(full, 'utf-8');
      // AST extraction is run on TSX files in the components walk.
      // Failure returns null and the indexer carries on.
      let props_json:  string | null = null;
      let events_json: string | null = null;
      if (pkg === 'components' && (ext === '.tsx' || ext === '.ts')) {
        const fileBase = item.replace(/\.(tsx|ts)$/i, '');
        if (fileBase.startsWith('Viro') || fileBase.startsWith('Studio')) {
          const api = extractApi(source, item, commonApi ?? undefined);
          if (api && (api.props.length > 0 || api.events.length > 0)) {
            props_json  = JSON.stringify(api.props);
            events_json = JSON.stringify(api.events);
          }
        }
      }
      results.push({ path: relPath, pkg, language, size: info.size, source, props_json, events_json });
    } catch {
      console.warn(`  ⚠ Could not read: ${relPath}`);
    }
  }
}

// ─── Doc indexer ─────────────────────────────────────────────────────────────

interface DocRow { name: string; path: string; content: string; }

async function indexDocs(results: DocRow[]): Promise<void> {
  for (const f of config.docs) {
    const full = join(config.projectDir, f);
    if (!(await exists(full))) { console.warn(`   ⚠ Doc not found: ${f}`); continue; }
    const content = await readFile(full, 'utf-8');
    results.push({ name: basename(f, '.md'), path: f, content });
    console.log(`   ✓ ${f}`);
  }
}

// ─── SQLite ───────────────────────────────────────────────────────────────────

function createDatabase(): Database.Database {
  if (!existsSync(KB_DIR)) mkdirSync(KB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    DROP TABLE IF EXISTS files_fts;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS docs;
    DROP TABLE IF EXISTS metadata;

    CREATE TABLE files (
      id          INTEGER PRIMARY KEY,
      path        TEXT NOT NULL UNIQUE,
      pkg         TEXT NOT NULL,
      language    TEXT NOT NULL,
      size        INTEGER NOT NULL,
      source      TEXT NOT NULL,
      props_json  TEXT,
      events_json TEXT
    );

    CREATE VIRTUAL TABLE files_fts USING fts5(
      path, source,
      content='files', content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TABLE docs (
      id      INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      path    TEXT NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
  `);
  // Embeddings survive a reindex (kept idempotent below), so file_vec is created
  // but never dropped. Orphaned rows are pruned in embedFiles().
  db.exec(`CREATE TABLE IF NOT EXISTS file_vec (id INTEGER PRIMARY KEY, embedding BLOB)`);
  return db;
}

function populateDatabase(db: Database.Database, files: FileRow[], docs: DocRow[]): void {
  const insFile = db.prepare(`INSERT OR IGNORE INTO files (path, pkg, language, size, source, props_json, events_json) VALUES (@path, @pkg, @language, @size, @source, @props_json, @events_json)`);
  const insFts  = db.prepare(`INSERT INTO files_fts (rowid, path, source) VALUES (?, ?, ?)`);
  const insDoc  = db.prepare(`INSERT INTO docs (name, path, content) VALUES (@name, @path, @content)`);
  const insMeta = db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

  console.log(`\n💾 Writing ${files.length} files to SQLite...`);

  db.transaction(() => {
    for (const f of files) {
      const info = insFile.run(f);
      if (info.changes > 0) insFts.run(info.lastInsertRowid, f.path, f.source);
    }
  })();

  db.transaction(() => { for (const d of docs) insDoc.run(d); })();

  insMeta.run('generated_at', new Date().toISOString());
  insMeta.run('project', config.projectDir);
  insMeta.run('file_count', String(files.length));
  insMeta.run('doc_count', String(docs.length));
}

// ─── Embeddings ────────────────────────────────────────────────────────────────

const EMBED_CONCURRENCY = 4;
const EMBED_MAX_RETRIES = 4;
const EMBED_CONTENT_MAX = 1800;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Vectorizes text via the AI gateway, retrying transient failures. */
async function embedText(text: string): Promise<Float32Array> {
  const { url, key, embedModel } = config.gateway;
  let lastErr: unknown;
  for (let attempt = 0; attempt < EMBED_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${url}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ model: embedModel, input: text }),
      });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText} ${await res.text().catch(() => '')}`);
      }
      const json = await res.json() as { data?: { embedding: number[] }[] };
      const vec = json?.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) throw new Error('response missing data[0].embedding');
      return Float32Array.from(vec);
    } catch (err) {
      lastErr = err;
      if (attempt < EMBED_MAX_RETRIES - 1) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Float32Array to a BLOB Buffer (native little-endian). */
function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Populates file_vec: embeds the same text FTS indexes (path + source, capped)
 * for every files row not embedded yet. Idempotent (skips already-embedded ids)
 * with bounded concurrency and retry. Skipped entirely when no gateway key is
 * set, so a keyless index still produces a working FTS-only DB.
 */
async function embedFiles(db: Database.Database): Promise<void> {
  if (!config.gateway.url || !config.gateway.key) {
    console.warn('\n⚠ AI_GATEWAY_KEY unset — skipping embeddings. Search will use FTS5 only.');
    console.warn('   Reindex with embeddings: AI_GATEWAY_KEY=… npm run index');
    return;
  }

  // Drop vectors whose file no longer exists (paths removed since last index).
  db.prepare(`DELETE FROM file_vec WHERE id NOT IN (SELECT id FROM files)`).run();

  const rows = db
    .prepare<[], { id: number; path: string; source: string }>(
      `SELECT id, path, source FROM files WHERE id NOT IN (SELECT id FROM file_vec)`,
    )
    .all();

  console.log(`\n🧠 Embeddings — ${rows.length} files pending (${config.gateway.embedModel})`);
  if (rows.length === 0) { console.log('   ✓ nothing to embed'); return; }

  const insert = db.prepare<[number, Buffer]>(`INSERT OR REPLACE INTO file_vec (id, embedding) VALUES (?, ?)`);

  let done = 0;
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < rows.length) {
      const row = rows[idx++]!;
      const text = `${row.path}\n${row.source.slice(0, EMBED_CONTENT_MAX)}`;
      const vec = await embedText(text);
      insert.run(row.id, toBlob(vec));
      done++;
      if (done % 100 === 0) console.log(`   ${done}/${rows.length}`);
    }
  }

  await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, () => worker()));
  console.log(`   ✓ ${done} embedded`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`🔍 ${config.name} — Indexer`);
  console.log(`   Project : ${config.projectDir}`);
  console.log(`   Output  : ${DB_PATH}\n`);

  if (!(await exists(config.projectDir))) {
    console.error(`❌ Project not found: ${config.projectDir}`);
    console.error('   Set PROJECT_DIR env var or update config.ts');
    process.exit(1);
  }

  const files: FileRow[] = [];

  // Walk configured directories
  for (const walk of config.walks) {
    const dir = join(config.projectDir, walk.dir);
    if (!(await exists(dir))) { console.warn(`⚠ Skipping (not found): ${walk.dir}`); continue; }
    console.log(`📦 Indexing ${walk.label} (${walk.dir})...`);
    // Resolved once per walk (only meaningful for 'components') so every
    // ViroBase subclass in it can merge in the common props/events — see
    // resolveCommonApi's doc comment.
    const commonApi = walk.label === 'components' ? await resolveCommonApi(dir) : null;
    if (walk.label === 'components' && commonApi) {
      console.log(`   ✓ common props/events resolved: ${commonApi.props.length} props, ${commonApi.events.length} events`);
    }
    const before = files.length;
    await walkDir(dir, walk.label, config.projectDir, new Set(walk.skipDirs), files, commonApi);
    console.log(`   ✓ ${files.length - before} files`);
  }

  // Root infra files
  if (config.rootFiles.length > 0) {
    console.log('🐳 Indexing root files...');
    for (const f of config.rootFiles) {
      const full = join(config.projectDir, f);
      if (!(await exists(full))) continue;
      const info = await stat(full);
      const source = await readFile(full, 'utf-8');
      files.push({ path: f, pkg: 'infra', language: getLanguage(f), size: info.size, source, props_json: null, events_json: null });
      console.log(`   ✓ ${f}`);
    }
  }

  // Infra dirs
  for (const d of config.infraDirs) {
    const dir = join(config.projectDir, d);
    if (!(await exists(dir))) continue;
    await walkDir(dir, 'infra', config.projectDir, new Set(), files, null);
  }

  // Breakdown
  const byPkg: Record<string, number> = {};
  const byLang: Record<string, number> = {};
  for (const f of files) {
    byPkg[f.pkg]      = (byPkg[f.pkg] ?? 0) + 1;
    byLang[f.language] = (byLang[f.language] ?? 0) + 1;
  }
  console.log('\n📊 By package:');
  for (const [k, v] of Object.entries(byPkg).sort())  console.log(`   ${k}: ${v}`);
  console.log('📊 By language:');
  for (const [k, v] of Object.entries(byLang).sort()) console.log(`   ${k}: ${v}`);
  const withApi = files.filter(f => f.props_json || f.events_json).length;
  console.log(`📊 AST extraction:`);
  console.log(`   components with extracted props/events: ${withApi}`);

  // Docs
  console.log('\n📄 Indexing docs...');
  const docs: DocRow[] = [];
  await indexDocs(docs);

  const db = createDatabase();
  populateDatabase(db, files, docs);
  await embedFiles(db);
  db.close();

  const dbStat = await stat(DB_PATH);
  console.log(`\n✅ Done — knowledge/${config.dbName} (${(dbStat.size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`   Files: ${files.length} | Docs: ${docs.length}`);
  console.log('Next: npm run build && node dist/src/index.js');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

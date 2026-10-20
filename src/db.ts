/**
 * reactviro-mcp-server — SQLite connection + query helpers
 * Generic implementation copied from mcp-starter.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { embed } from './embed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/db.ts runs from src/ under tsx and from dist/src/ once built, so the
// repo root is one or two levels up.
const ROOT = [join(__dirname, '..'), join(__dirname, '..', '..')]
  .find((dir) => existsSync(join(dir, 'package.json'))) ?? join(__dirname, '..', '..');
export const KB_DIR = join(ROOT, 'knowledge');
export const DB_PATH = join(KB_DIR, config.dbName);

type B = Record<string, string | number | null>;

export interface FileRowMeta {
  id: number;
  path: string;
  pkg: string;
  language: string;
  size: number;
}

export interface FileRow extends FileRowMeta {
  source:      string;
  props_json:  string | null;
  events_json: string | null;
}

/** Lightweight row for AST-aware queries (avoids loading full source). */
export interface ApiRow {
  path:        string;
  pkg:         string;
  props_json:  string | null;
  events_json: string | null;
}

export interface DocRow {
  id: number;
  name: string;
  path: string;
  content: string;
}

export interface SearchHit {
  path: string;
  pkg: string;
  language: string;
  line: number;
  text: string;
}

export interface StarterDb {
  db: Database.Database;
  listFiles(opts: { pkg?: string; language?: string; path?: string; limit: number; offset: number }): { total: number; rows: FileRowMeta[] };
  getFile(partial: string): FileRow | undefined | 'multiple';
  search(opts: { query: string; pkg?: string; language?: string; limit: number }): SearchHit[];
  /**
   * Hybrid search: FTS5 candidates fused with query-embedding cosine similarity
   * via Reciprocal Rank Fusion. Falls back to the sync FTS `search` when there
   * are no vectors or the embed call throws. Same output shape as `search`.
   */
  searchFilesHybrid(opts: { query: string; pkg?: string; language?: string; limit: number }): Promise<SearchHit[]>;
  getDoc(name: string): DocRow | undefined;
  listDocs(): Pick<DocRow, 'id' | 'name' | 'path'>[];
  meta(): { generated_at: string; project: string; file_count: number; doc_count: number };
  /** Returns AST-extracted props/events for every component file that has them. */
  listApi(opts?: { pkg?: string }): ApiRow[];
}

// ── Vector helpers ─────────────────────────────────────────────────────────────

/** Turns a BLOB (Buffer) from the DB into a Float32Array (own aligned copy). */
function blobToVec(buf: Buffer): Float32Array {
  // slice() yields a fresh ArrayBuffer at offset 0, so alignment is guaranteed.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

/** Cosine similarity between two vectors of equal length. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function openDb(): StarterDb {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');

  const stmtCount = db.prepare<[B], { n: number }>(`
    SELECT COUNT(*) AS n FROM files WHERE 1=1
      AND (@pkg      IS NULL OR pkg      = @pkg)
      AND (@language IS NULL OR language = @language)
      AND (@path     IS NULL OR LOWER(path) LIKE '%' || LOWER(@path) || '%')
  `);

  const stmtList = db.prepare<[B], FileRowMeta>(`
    SELECT id, path, pkg, language, size FROM files WHERE 1=1
      AND (@pkg      IS NULL OR pkg      = @pkg)
      AND (@language IS NULL OR language = @language)
      AND (@path     IS NULL OR LOWER(path) LIKE '%' || LOWER(@path) || '%')
    ORDER BY path LIMIT @limit OFFSET @offset
  `);

  const stmtExact   = db.prepare<[string], FileRow>(`SELECT * FROM files WHERE path = ?`);
  const stmtPartial = db.prepare<[string], FileRow>(`SELECT * FROM files WHERE LOWER(path) LIKE '%' || LOWER(?) || '%' ORDER BY path`);
  const stmtSource  = db.prepare<[number], { source: string }>(`SELECT source FROM files WHERE id = ?`);

  const stmtFts = db.prepare<[B], { id: number; path: string; pkg: string; language: string; rank: number }>(`
    SELECT f.id, f.path, f.pkg, f.language, fts.rank
    FROM files_fts fts JOIN files f ON f.id = fts.rowid
    WHERE files_fts MATCH @query
      AND (@pkg      IS NULL OR f.pkg      = @pkg)
      AND (@language IS NULL OR f.language = @language)
    ORDER BY fts.rank LIMIT @limit
  `);

  const stmtGetDoc  = db.prepare<[string, string], DocRow>(`SELECT * FROM docs WHERE LOWER(name) = LOWER(?) OR LOWER(name) LIKE '%' || LOWER(?) || '%' LIMIT 1`);
  const stmtListDoc = db.prepare<[], Pick<DocRow, 'id' | 'name' | 'path'>>(`SELECT id, name, path FROM docs ORDER BY name`);
  const stmtMeta    = db.prepare<[], { key: string; value: string }>(`SELECT key, value FROM metadata`);

  const stmtApi    = db.prepare<[B], ApiRow>(`
    SELECT path, pkg, props_json, events_json FROM files
    WHERE (props_json IS NOT NULL OR events_json IS NOT NULL)
      AND (@pkg IS NULL OR pkg = @pkg)
    ORDER BY path
  `);

  const stmtFileMeta = db.prepare<[number], { id: number; path: string; pkg: string; language: string }>(
    `SELECT id, path, pkg, language FROM files WHERE id = ?`,
  );

  // File vectors loaded once into memory (lazy). null = not loaded yet.
  let fileVecs: Map<number, Float32Array> | null = null;

  function tableExists(name: string): boolean {
    return !!db
      .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  }

  function getFileVecs(): Map<number, Float32Array> {
    if (fileVecs !== null) return fileVecs;
    const map = new Map<number, Float32Array>();
    // Guarded via sqlite_master so this works when file_vec is absent (no key
    // set at index time). Empty map → hybrid search falls back to pure FTS.
    if (tableExists('file_vec')) {
      const rows = db
        .prepare<[], { id: number; embedding: Buffer }>(`SELECT id, embedding FROM file_vec`)
        .all();
      for (const row of rows) {
        if (row.embedding) map.set(row.id, blobToVec(row.embedding));
      }
    }
    fileVecs = map;
    return map;
  }

  function lineHits(rows: { id: number; path: string; pkg: string; language: string }[], regex: RegExp, limit: number): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const row of rows) {
      if (hits.length >= limit) break;
      const src = stmtSource.get(row.id);
      if (!src) continue;
      const lines = src.source.split('\n');
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (regex.test(lines[i]!)) {
          hits.push({ path: row.path, pkg: row.pkg, language: row.language, line: i + 1, text: lines[i]!.trim() });
        }
      }
    }
    return hits;
  }

  return {
    db,

    listFiles({ pkg, language, path, limit, offset }) {
      const p: B = { pkg: pkg ?? null, language: language ?? null, path: path ?? null, limit, offset };
      const { n } = stmtCount.get(p)!;
      return { total: n, rows: stmtList.all(p) };
    },

    getFile(partial) {
      const exact = stmtExact.get(partial);
      if (exact) return exact;
      const matches = stmtPartial.all(partial);
      if (matches.length === 0) return undefined;
      if (matches.length === 1) return matches[0];
      return 'multiple';
    },

    search({ query, pkg, language, limit }) {
      let ftsRows: { id: number; path: string; pkg: string; language: string; rank: number }[] = [];
      try { ftsRows = stmtFts.all({ query, pkg: pkg ?? null, language: language ?? null, limit: limit * 5 }); } catch { /* fallback */ }

      let regex: RegExp;
      try { regex = new RegExp(query, 'i'); } catch { return []; }

      if (ftsRows.length > 0) return lineHits(ftsRows, regex, limit);

      const pool = stmtList.all({ pkg: pkg ?? null, language: language ?? null, path: null, limit: 99999, offset: 0 });
      return lineHits(pool, regex, limit);
    },

    async searchFilesHybrid({ query, pkg, language, limit }) {
      const vecs = getFileVecs();
      // No vectors → pure FTS (never worse than today).
      if (vecs.size === 0) return this.search({ query, pkg, language, limit });

      // A valid line regex is required to turn candidate files into line hits,
      // exactly as the sync FTS path does. Bail to FTS on an invalid pattern.
      let regex: RegExp;
      try { regex = new RegExp(query, 'i'); } catch { return this.search({ query, pkg, language, limit }); }

      // (a) FTS candidate files, in rank order (top ~30).
      let ftsIds: number[] = [];
      try {
        const ftsRows = stmtFts.all({ query, pkg: pkg ?? null, language: language ?? null, limit: 30 });
        ftsIds = ftsRows.map(r => r.id);
      } catch { /* MATCH syntax rejected the query → rely on vectors */ }

      // (b) Query vector. If the gateway fails → pure FTS.
      let qVec: Float32Array;
      try {
        qVec = await embed(query);
      } catch {
        return this.search({ query, pkg, language, limit });
      }

      // pkg/language filter applied to the vector set.
      let allowed: Set<number> | null = null;
      if (pkg || language) {
        const ids = db
          .prepare<B, { id: number }>(
            `SELECT id FROM files WHERE 1=1
               AND (@pkg      IS NULL OR pkg      = @pkg)
               AND (@language IS NULL OR language = @language)`,
          )
          .all({ pkg: pkg ?? null, language: language ?? null })
          .map(r => r.id);
        allowed = new Set(ids);
      }

      // (c) Cosine similarity against every vector, top ~30.
      const scored: { id: number; score: number }[] = [];
      for (const [id, vec] of vecs) {
        if (allowed && !allowed.has(id)) continue;
        scored.push({ id, score: cosine(qVec, vec) });
      }
      scored.sort((a, b) => b.score - a.score);
      const vecIds = scored.slice(0, 30).map(s => s.id);

      // (d) Reciprocal Rank Fusion (k=60).
      const K = 60;
      const rrf = new Map<number, number>();
      ftsIds.forEach((id, rank) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (K + rank)));
      vecIds.forEach((id, rank) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (K + rank)));

      // Order the fused candidate files, then materialize their line hits. The
      // pool is widened past `limit` because not every file yields a line hit.
      const fusedIds = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit * 5).map(e => e[0]);
      if (fusedIds.length === 0) return this.search({ query, pkg, language, limit });

      const rows = fusedIds
        .map(id => stmtFileMeta.get(id))
        .filter((r): r is { id: number; path: string; pkg: string; language: string } => !!r);

      return lineHits(rows, regex, limit);
    },

    getDoc(name) {
      const q = name.replace(/\.md$/i, '');
      return stmtGetDoc.get(q, q);
    },

    listDocs() { return stmtListDoc.all(); },

    meta() {
      const m: Record<string, string> = {};
      for (const { key, value } of stmtMeta.all()) m[key] = value;
      return { generated_at: m['generated_at'] ?? '', project: m['project'] ?? '',
        file_count: Number(m['file_count'] ?? 0), doc_count: Number(m['doc_count'] ?? 0) };
    },

    listApi({ pkg } = {}) {
      return stmtApi.all({ pkg: pkg ?? null });
    },
  };
}

/**
 * embed.ts — Embeddings client.
 *
 * Talks to the OpenAI-compatible AI gateway (POST {url}/embeddings) to
 * vectorize text. Uses the global fetch of Node 20+. Throws on error so the
 * caller can fall back to pure FTS.
 */

import { config } from '../config.js';

interface EmbeddingsResponse {
  data?: { embedding: number[] }[];
}

/** Vectorizes `text` and returns the embedding as a Float32Array. */
export async function embed(text: string): Promise<Float32Array> {
  if (!config.gateway.url) throw new Error('AI_GATEWAY_URL is not set');
  const res = await fetch(`${config.gateway.url}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.gateway.key ? { Authorization: `Bearer ${config.gateway.key}` } : {}),
    },
    body: JSON.stringify({ model: config.gateway.embedModel, input: text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`/embeddings failed: ${res.status} ${res.statusText} ${body}`);
  }

  const json = (await res.json()) as EmbeddingsResponse;
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('/embeddings response missing data[0].embedding');
  }
  return Float32Array.from(vec);
}

import { z } from 'zod';

/**
 * Retrieval (RAG) wire types. Mirrors the AiProvider surface but for
 * vector stores / knowledge bases: `search`, `store`, `delete`, and
 * collection listing. Adapters translate into their backend's native
 * protocol (chroma-mcp over stdio, Postgres+pgvector over SQL, …).
 *
 * Score semantics: every adapter normalizes `score` to cosine similarity
 * in the `0..1` range (higher = more relevant). When a backend exposes
 * raw distance, adapters also forward it on `distance` so callers can
 * inspect the untransformed value if they need it.
 */

export const DocumentSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * Caller-supplied embedding. Backends that embed internally (Chroma)
   * may ignore this when absent and compute it themselves. Backends
   * that don't (pgvector v1) require it on `store`.
   */
  vector: z.array(z.number()).optional(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const SearchResultSchema = z.object({
  document: DocumentSchema,
  score: z.number(),
  distance: z.number().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(100).default(10),
  /** Metadata filter. Backend-specific syntax; passed through opaquely. */
  filter: z.record(z.string(), z.unknown()).optional(),
  /** When absent, the adapter uses the node's default collection. */
  collection: z.string().optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  collection: z.string(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const StoreRequestSchema = z.object({
  documents: z.array(DocumentSchema).min(1),
  collection: z.string().optional(),
});
export type StoreRequest = z.infer<typeof StoreRequestSchema>;

export const StoreResponseSchema = z.object({
  ids: z.array(z.string()),
  collection: z.string(),
});
export type StoreResponse = z.infer<typeof StoreResponseSchema>;

export const DeleteRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  collection: z.string().optional(),
});
export type DeleteRequest = z.infer<typeof DeleteRequestSchema>;

export const DeleteResponseSchema = z.object({
  deleted: z.number().int().min(0),
  collection: z.string(),
});
export type DeleteResponse = z.infer<typeof DeleteResponseSchema>;

export const CollectionInfoSchema = z.object({
  name: z.string(),
  count: z.number().int().min(0).optional(),
  dimensions: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CollectionInfo = z.infer<typeof CollectionInfoSchema>;

export const ListCollectionsResponseSchema = z.object({
  collections: z.array(CollectionInfoSchema),
});
export type ListCollectionsResponse = z.infer<typeof ListCollectionsResponseSchema>;

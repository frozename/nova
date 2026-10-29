import { describe, expect, test } from "bun:test";

import {
  CollectionInfoSchema,
  DeleteRequestSchema,
  DeleteResponseSchema,
  DocumentSchema,
  ListCollectionsResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SearchResultSchema,
  StoreRequestSchema,
  StoreResponseSchema,
} from "../src/index.js";

/**
 * Pins the retrieval (RAG) wire schemas in `src/schemas/retrieval.ts`.
 * Downstream RAG adapters (llamactl, embersynth) validate search, store,
 * delete and collection-listing payloads against these, so the bounds
 * and defaults below are part of the public contract:
 *  - search topK is an integer in 1..100 and defaults to 10
 *  - query and document ids are non-empty
 *  - store and delete need at least one document / id
 *  - delete counts and collection sizes are non-negative integers, and
 *    collection dimensions are positive
 * Assertions use safeParse(...).success and parsed values only.
 */

const DOC = {
  content: "hello",
  id: "doc-1",
  metadata: { lang: "en", page: 3 },
  vector: [0.1, 0.2, 0.3],
};

describe("retrieval SearchRequestSchema", () => {
  test("fills topK with 10 when it is absent", () => {
    expect(SearchRequestSchema.parse({ query: "q" }).topK).toBe(10);
  });

  test("accepts topK at the bounds 1 and 100", () => {
    expect(SearchRequestSchema.safeParse({ query: "q", topK: 1 }).success).toBe(true);
    expect(SearchRequestSchema.safeParse({ query: "q", topK: 100 }).success).toBe(true);
  });

  test("rejects topK 0, 101 and 1.5", () => {
    expect(SearchRequestSchema.safeParse({ query: "q", topK: 0 }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "q", topK: 101 }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "q", topK: 1.5 }).success).toBe(false);
  });

  test("rejects an empty query", () => {
    expect(SearchRequestSchema.safeParse({ query: "" }).success).toBe(false);
  });

  test("passes filter and collection through unchanged", () => {
    const req = { collection: "docs", filter: { lang: "en" }, query: "q", topK: 3 };
    expect(SearchRequestSchema.parse(req)).toEqual(req);
  });
});

describe("retrieval DocumentSchema", () => {
  test("rejects an empty id", () => {
    expect(DocumentSchema.safeParse({ ...DOC, id: "" }).success).toBe(false);
  });

  test("keeps metadata and vector", () => {
    expect(DocumentSchema.parse(DOC)).toEqual(DOC);
  });
});

describe("retrieval SearchResultSchema", () => {
  test("keeps an optional distance and accepts its absence", () => {
    expect(SearchResultSchema.parse({ distance: 0.4, document: DOC, score: 0.8 }).distance).toBe(
      0.4,
    );
    expect("distance" in SearchResultSchema.parse({ document: DOC, score: 0.8 })).toBe(false);
  });
});

describe("retrieval StoreRequestSchema", () => {
  test("rejects an empty documents array", () => {
    expect(StoreRequestSchema.safeParse({ documents: [] }).success).toBe(false);
  });

  test("accepts one document and a collection", () => {
    const req = { collection: "docs", documents: [DOC] };
    expect(StoreRequestSchema.parse(req)).toEqual(req);
  });
});

describe("retrieval DeleteRequestSchema", () => {
  test("rejects an empty ids array and an empty id", () => {
    expect(DeleteRequestSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(DeleteRequestSchema.safeParse({ ids: [""] }).success).toBe(false);
  });

  test("accepts non-empty ids", () => {
    expect(DeleteRequestSchema.parse({ ids: ["doc-1"] })).toEqual({ ids: ["doc-1"] });
  });
});

describe("retrieval DeleteResponseSchema", () => {
  test("rejects a negative or fractional deleted count", () => {
    expect(DeleteResponseSchema.safeParse({ collection: "docs", deleted: -1 }).success).toBe(false);
    expect(DeleteResponseSchema.safeParse({ collection: "docs", deleted: 1.5 }).success).toBe(
      false,
    );
  });

  test("accepts a deleted count of 0", () => {
    expect(DeleteResponseSchema.safeParse({ collection: "docs", deleted: 0 }).success).toBe(true);
  });
});

describe("retrieval CollectionInfoSchema", () => {
  test("rejects dimensions 0 and count -1", () => {
    expect(CollectionInfoSchema.safeParse({ dimensions: 0, name: "docs" }).success).toBe(false);
    expect(CollectionInfoSchema.safeParse({ count: -1, name: "docs" }).success).toBe(false);
  });

  test("accepts a bare name", () => {
    expect(CollectionInfoSchema.parse({ name: "docs" })).toEqual({ name: "docs" });
  });
});

describe("retrieval response schemas", () => {
  test("SearchResponseSchema round-trips a well-formed payload", () => {
    const res = { collection: "docs", results: [{ distance: 0.4, document: DOC, score: 0.8 }] };
    expect(SearchResponseSchema.parse(res)).toEqual(res);
  });

  test("StoreResponseSchema round-trips a well-formed payload", () => {
    const res = { collection: "docs", ids: ["doc-1", "doc-2"] };
    expect(StoreResponseSchema.parse(res)).toEqual(res);
  });

  test("ListCollectionsResponseSchema round-trips a well-formed payload", () => {
    const res = {
      collections: [
        { count: 2, dimensions: 768, metadata: { owner: "rag" }, name: "docs" },
        { name: "empty" },
      ],
    };
    expect(ListCollectionsResponseSchema.parse(res)).toEqual(res);
  });
});

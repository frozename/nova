/**
 * MCP tool handlers return a `{ content: [...] }` envelope. Serializing
 * arbitrary JSON as a text block is the common case for operator
 * tools — the shape lands in one place so every llamactl-family MCP
 * server renders tool output identically.
 */

/**
 * Shape of an MCP tool-handler return value. Matches the SDK's
 * `CallToolResult` index-signature so handlers stay assignable
 * without a cast.
 */
export interface TextContentEnvelope {
  content: Array<{ type: 'text'; text: string }>;
  [key: string]: unknown;
}

export function toTextContent(payload: unknown): TextContentEnvelope {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

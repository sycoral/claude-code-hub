/**
 * Audit preprocessor: cleans request/response content before persisting to audit logs.
 * - Strips large base64 image data
 * - Truncates oversized messages
 * - Extracts text summaries for search
 */

interface ContentBlock {
  type: string;
  text?: string;
  source?: { type?: string; data?: string };
  [key: string]: unknown;
}

interface Message {
  role: string;
  content: string | ContentBlock[];
  [key: string]: unknown;
}

interface RequestLike {
  messages?: Message[];
  [key: string]: unknown;
}

interface PreprocessResult {
  request: RequestLike;
  response: unknown;
  originalSize: number;
  truncated: boolean;
}

/**
 * Extract the first user message text from a request object, truncated to maxLength characters.
 * Returns empty string if no user messages found.
 */
export function extractSummary(request: RequestLike, maxLength: number): string {
  const messages = request.messages ?? [];
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";

  let text = "";
  if (typeof firstUser.content === "string") {
    text = firstUser.content;
  } else if (Array.isArray(firstUser.content)) {
    const textBlock = firstUser.content.find(
      (b) => b.type === "text" && typeof b.text === "string"
    );
    text = textBlock?.text ?? "";
  }

  return text.slice(0, maxLength);
}

/**
 * Deep-clone and preprocess request+response for audit storage.
 * - Strips image base64 data (> 200 chars) with a size placeholder
 * - Truncates individual messages exceeding maxMessageSize
 * - Returns original byte size and whether any truncation occurred
 */
export function preprocessAuditContent(
  request: RequestLike,
  response: unknown,
  maxMessageSize: number
): PreprocessResult {
  const originalJson = JSON.stringify({ request, response });
  const originalSize = Buffer.byteLength(originalJson, "utf-8");

  const clonedRequest: RequestLike = JSON.parse(JSON.stringify(request));
  const clonedResponse: unknown = JSON.parse(JSON.stringify(response));

  let truncated = false;

  function processContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
    for (const block of blocks) {
      // Strip image base64
      if (
        block.source?.data &&
        typeof block.source.data === "string" &&
        block.source.data.length > 200
      ) {
        const sizeKB = (Buffer.byteLength(block.source.data, "utf-8") / 1024)
          .toFixed(1)
          .replace(/\.0$/, "");
        block.source.data = `[IMAGE: ${sizeKB} KB]`;
        truncated = true;
      }

      // Truncate text blocks
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > maxMessageSize
      ) {
        block.text = `${block.text.slice(0, maxMessageSize)}... [TRUNCATED]`;
        truncated = true;
      }
    }
    return blocks;
  }

  function processMessages(messages: Message[]): void {
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        if (msg.content.length > maxMessageSize) {
          msg.content = `${msg.content.slice(0, maxMessageSize)}... [TRUNCATED]`;
          truncated = true;
        }
      } else if (Array.isArray(msg.content)) {
        processContentBlocks(msg.content);
      }
    }
  }

  if (clonedRequest.messages) {
    processMessages(clonedRequest.messages);
  }

  // Also process response content blocks if present
  if (clonedResponse && typeof clonedResponse === "object" && "content" in clonedResponse) {
    const resp = clonedResponse as { content?: unknown };
    if (Array.isArray(resp.content)) {
      processContentBlocks(resp.content as ContentBlock[]);
    }
  }

  return {
    request: clonedRequest,
    response: clonedResponse,
    originalSize,
    truncated,
  };
}

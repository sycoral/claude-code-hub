/**
 * Audit preprocessor: cleans request/response content before persisting to audit logs.
 * - Strips large base64 image data
 * - Truncates oversized messages
 * - Extracts text summaries for search
 */

interface ContentBlock {
  type: string;
  text?: string;
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
    _originalSizeKB?: string;
    _truncated?: string;
  };
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
 * Extract the LAST user message text from a request object, truncated to maxLength characters.
 * Uses the last user message because each API request carries the full conversation history,
 * and the last user message represents the actual new input for this request.
 * Returns empty string if no user messages found.
 */
export function extractSummary(request: RequestLike, maxLength: number): string {
  // Support both Claude (messages[]) and Codex/OpenAI Response API (input[]) formats
  const messages = request.messages ?? [];
  const input = (request as Record<string, unknown>).input;
  const allMessages =
    messages.length > 0 ? messages : Array.isArray(input) ? (input as Message[]) : [];

  const userMessages = allMessages.filter((m) => m.role === "user");
  const lastUser = userMessages.length > 0 ? userMessages[userMessages.length - 1] : undefined;
  if (!lastUser) return "";

  let text = "";
  if (typeof lastUser.content === "string") {
    text = lastUser.content;
  } else if (Array.isArray(lastUser.content)) {
    // Claude: { type: "text", text: "..." } or Codex: { type: "input_text", text: "..." }
    const textBlock = lastUser.content.find(
      (b) => (b.type === "text" || b.type === "input_text") && typeof b.text === "string"
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

  // Max base64 size to keep for thumbnail (~100KB of base64 = ~75KB image)
  const MAX_IMAGE_BASE64 = 100 * 1024;

  function processContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
    for (const block of blocks) {
      // Claude format: { type: "image", source: { type: "base64", data: "..." } }
      if (
        block.source?.data &&
        typeof block.source.data === "string" &&
        block.source.data.length > MAX_IMAGE_BASE64
      ) {
        // Keep a thumbnail-sized portion of the base64 data
        const originalSize = block.source.data.length;
        const sizeKB = (Buffer.byteLength(block.source.data, "utf-8") / 1024).toFixed(0);
        block.source.data = block.source.data.slice(0, MAX_IMAGE_BASE64);
        block.source._originalSizeKB = sizeKB;
        block.source._truncated = "true";
        truncated = true;
      }

      // Codex format: { type: "input_image", image_url: "data:image/png;base64,..." }
      if (
        block.type === "input_image" &&
        typeof (block as Record<string, unknown>).image_url === "string"
      ) {
        const imageUrl = (block as Record<string, unknown>).image_url as string;
        if (imageUrl.startsWith("data:") && imageUrl.length > MAX_IMAGE_BASE64) {
          const sizeKB = (Buffer.byteLength(imageUrl, "utf-8") / 1024).toFixed(0);
          (block as Record<string, unknown>).image_url = imageUrl.slice(0, MAX_IMAGE_BASE64);
          (block as Record<string, unknown>)._originalSizeKB = sizeKB;
          (block as Record<string, unknown>)._truncated = "true";
          truncated = true;
        }
      }

      // Truncate text blocks
      if (
        (block.type === "text" || block.type === "input_text") &&
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

  // Also process Codex input[] array
  const clonedInput = (clonedRequest as Record<string, unknown>).input;
  if (Array.isArray(clonedInput)) {
    // input items can be messages (with content[]) or direct content blocks (type: "input_image")
    for (const item of clonedInput) {
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        if (Array.isArray(obj.content)) {
          processContentBlocks(obj.content as ContentBlock[]);
        }
        // Direct content block (e.g., { type: "input_image", image_url: "..." })
        if (typeof obj.type === "string") {
          processContentBlocks([obj as unknown as ContentBlock]);
        }
      }
    }
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

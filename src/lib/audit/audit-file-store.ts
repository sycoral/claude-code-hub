import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { logger } from "@/lib/logger";

/**
 * JSONL file store for audit logs.
 * Organizes files as {baseDir}/{YYYY}/{MM}/{sessionId}.jsonl
 * with automatic rolling when file size exceeds maxFileSize.
 */
export class AuditFileStore {
  private readonly baseDir: string;
  private readonly maxFileSize: number;

  constructor(baseDir: string, maxFileSize: number) {
    this.baseDir = baseDir;
    this.maxFileSize = maxFileSize;
  }

  /**
   * Append a JSON line to the session's JSONL file.
   * Creates year/month subdirectories as needed.
   * Rolls to a new file if appending would exceed maxFileSize.
   * Returns the relative path from baseDir (forward slashes).
   */
  async appendLine(sessionId: string, line: string): Promise<string> {
    const { year, month } = this.currentYearMonth();
    const dir = path.join(this.baseDir, year, month);
    await fsp.mkdir(dir, { recursive: true });

    // Calculate incoming data size (line + newline)
    const incomingSize = Buffer.byteLength(line, "utf-8") + 1;
    const relPath = await this.resolveCurrentFile(sessionId, year, month, incomingSize);
    const fullPath = path.join(this.baseDir, ...relPath.split("/"));

    await fsp.appendFile(fullPath, `${line}\n`, "utf-8");

    return relPath;
  }

  /**
   * Read lines from a JSONL file.
   * Returns array of non-empty lines from offset to offset+limit.
   */
  async readLines(relativePath: string, offset: number, limit: number): Promise<string[]> {
    const fullPath = path.join(this.baseDir, ...relativePath.split("/"));
    const content = await fsp.readFile(fullPath, "utf-8");
    const allLines = content.split("\n").filter((l) => l.length > 0);
    return allLines.slice(offset, offset + limit);
  }

  /**
   * Gzip compress a file, delete original, return new .gz relative path.
   */
  async compressFile(relativePath: string): Promise<string> {
    const fullPath = path.join(this.baseDir, ...relativePath.split("/"));
    const gzPath = `${fullPath}.gz`;
    const gzRelPath = `${relativePath}.gz`;

    const source = fs.createReadStream(fullPath);
    const destination = fs.createWriteStream(gzPath);
    const gzip = createGzip();

    await pipeline(source, gzip, destination);
    await fsp.unlink(fullPath);

    logger.debug({ relativePath, gzRelPath }, "Compressed audit file");
    return gzRelPath;
  }

  /**
   * Get the relative path for the current month (without checking existence).
   */
  getRelativePath(sessionId: string): string {
    const { year, month } = this.currentYearMonth();
    return `${year}/${month}/${sessionId}.jsonl`;
  }

  // --- private helpers ---

  private currentYearMonth(): { year: string; month: string } {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return { year, month };
  }

  /**
   * Resolve the current file path for a session, rolling if needed.
   * If adding incomingSize bytes would exceed maxFileSize, roll to next file.
   * Returns a forward-slash relative path.
   */
  private async resolveCurrentFile(
    sessionId: string,
    year: string,
    month: string,
    incomingSize: number
  ): Promise<string> {
    const dir = path.join(this.baseDir, year, month);
    const baseName = `${sessionId}.jsonl`;
    let currentFile = path.join(dir, baseName);

    // Check the base file first - roll if adding new data would exceed limit
    if (await this.fileExists(currentFile)) {
      const stat = await fsp.stat(currentFile);
      if (stat.size + incomingSize > this.maxFileSize) {
        // Need to roll - find next available index
        let rollIndex = 1;
        while (await this.fileExists(path.join(dir, `${sessionId}.${rollIndex}.jsonl`))) {
          const rollStat = await fsp.stat(path.join(dir, `${sessionId}.${rollIndex}.jsonl`));
          if (rollStat.size + incomingSize <= this.maxFileSize) {
            break;
          }
          rollIndex++;
        }
        currentFile = path.join(dir, `${sessionId}.${rollIndex}.jsonl`);
      }
    }

    return path.relative(this.baseDir, currentFile).replace(/\\/g, "/");
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

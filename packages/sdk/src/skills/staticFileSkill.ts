import { open } from 'node:fs/promises';
import type { Asset } from '@elisym/pay-core';
import { isBlockingNode } from '../agent-store/node-type';
import { resolveInsidePathReal } from './path-safety';
import type {
  Skill,
  SkillContext,
  SkillInput,
  SkillLlmOverride,
  SkillMode,
  SkillOutput,
} from './types';

/** Hard ceiling on result size for static-file skills. NIP-90 result events
 *  travel through relays that may reject very large payloads; cap at 256 KB
 *  of UTF-8. Larger files should use a script that streams to an external host. */
export const MAX_STATIC_FILE_SIZE = 256 * 1024;

export interface StaticFileSkillParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  /** Absolute path to the file whose contents are returned on each job. */
  outputFilePath: string;
  /** Skill directory the output file must stay inside (re-checked per read). */
  skillDir: string;
  image?: string;
  imageFile?: string;
  /**
   * Declared LLM dependency. The skill itself never calls an LLM, but if
   * the file is produced by an external pipeline that depends on a key,
   * operators can declare the (provider, model) pair so the runtime can
   * health-monitor it. Carried through from SKILL.md as-is.
   */
  llmOverride?: SkillLlmOverride;
}

/**
 * Returns the contents of a fixed file as the job result. Reads on every
 * `execute()` so authors can edit the file without restarting the agent.
 */
export class StaticFileSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  mode: SkillMode = 'static-file';
  image?: string;
  imageFile?: string;
  llmOverride?: SkillLlmOverride;
  private outputFilePath: string;
  private skillDir: string;

  constructor(params: StaticFileSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.llmOverride = params.llmOverride;
    this.outputFilePath = params.outputFilePath;
    this.skillDir = params.skillDir;
  }

  async execute(_input: SkillInput, _ctx: SkillContext): Promise<SkillOutput> {
    // Load-time containment cannot see a symlink swapped in after load (TOCTOU):
    // re-run the symlink-aware check at every read, since the file's contents
    // are handed to a paying customer.
    const safePath = resolveInsidePathReal(this.skillDir, this.outputFilePath);
    if (safePath === null) {
      throw new Error('static-file "output_file" escapes the skill directory');
    }
    // The gate every other reader of a file inside a skill directory uses. This
    // one runs while a paying customer waits for the result.
    if (await isBlockingNode(safePath)) {
      throw new Error('static-file "output_file" is a pipe, socket or device, not a file');
    }
    // Measure UTF-8 bytes, not JS string length: relays reject by byte size,
    // and a non-ASCII file is 1.5-4x its char count in UTF-8.
    return { data: (await readCapped(safePath)).toString('utf-8') };
  }
}

/**
 * Read at most `MAX_STATIC_FILE_SIZE` bytes, refusing a larger file before
 * reading it: the size is checked on the open handle first, and the read stops
 * one byte past the cap, so a file that grew after the check is refused too and
 * a huge one is never pulled into memory while a paying customer waits.
 */
async function readCapped(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size > MAX_STATIC_FILE_SIZE) {
      throw new Error(`static-file output exceeds ${MAX_STATIC_FILE_SIZE} bytes (got ${size})`);
    }
    const buffer = Buffer.alloc(MAX_STATIC_FILE_SIZE + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    if (filled > MAX_STATIC_FILE_SIZE) {
      throw new Error(`static-file output exceeds ${MAX_STATIC_FILE_SIZE} bytes`);
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

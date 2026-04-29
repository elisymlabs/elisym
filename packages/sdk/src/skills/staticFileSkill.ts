import { readFile } from 'node:fs/promises';
import type { Asset } from '../payment/assets';
import type { Skill, SkillContext, SkillInput, SkillMode, SkillOutput } from './types';

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
  image?: string;
  imageFile?: string;
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
  private outputFilePath: string;

  constructor(params: StaticFileSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.outputFilePath = params.outputFilePath;
  }

  async execute(_input: SkillInput, _ctx: SkillContext): Promise<SkillOutput> {
    // Measure UTF-8 bytes, not JS string length: relays reject by byte size,
    // and a non-ASCII file is 1.5-4x its char count in UTF-8.
    const buffer = await readFile(this.outputFilePath);
    if (buffer.length > MAX_STATIC_FILE_SIZE) {
      throw new Error(
        `static-file output exceeds ${MAX_STATIC_FILE_SIZE} bytes (got ${buffer.length})`,
      );
    }
    return { data: buffer.toString('utf-8') };
  }
}

/**
 * The git blob id: SHA-1 over `blob <length>\0` followed by the bytes, in git's
 * SHA-1 object format, as 40 lowercase hex characters. The one implementation
 * in the service: the fetcher, both CLIs and anything that names a blob by its
 * git id import it from here, so no two copies can disagree about the id a
 * blob is stored under.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** The git blob id of a whole buffer. */
export function gitBlobHash(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

/**
 * The git blob id of the file at `path`, whose size is `size` bytes, hashed
 * while it is read. The header carries the size before any byte is read, so a
 * file that turns out longer or shorter than declared is refused rather than
 * answered with an id for bytes it does not hold.
 */
export async function gitBlobHashOfFile(path: string, size: number): Promise<string> {
  const hash = createHash('sha1').update(`blob ${String(size)}\0`);
  let read = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    read += bytes.length;
    hash.update(bytes);
  }
  if (read !== size) {
    throw new Error(
      `A file changed size while it was hashed: ${String(read)} of ${String(size)} bytes.`,
    );
  }
  return hash.digest('hex');
}

/**
 * Filesystem manners: guessing a content type, refusing to clobber, and
 * writing a download so a crash never leaves a half file wearing a real name.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Small, deliberate table — enough that the phone shows a preview instead of a blob. */
const MIME_BY_EXT = new Map(
  Object.entries({
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/plain',
    '.py': 'text/x-python',
    '.sh': 'text/x-shellscript',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.ico': 'image/vnd.microsoft.icon',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tgz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.7z': 'application/x-7z-compressed',
    '.dmg': 'application/x-apple-diskimage',
    '.epub': 'application/epub+zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }),
);

export function guessMimeType(filename) {
  return MIME_BY_EXT.get(path.extname(String(filename)).toLowerCase()) ?? 'application/octet-stream';
}

/** Control characters and the characters that break other people's filesystems. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const HOSTILE_CHARS = /[<>:"|?*]/g;

/** The name of last resort, when even the caller's fallback is unusable. */
const LAST_RESORT_NAME = 'transfer.bin';

/** One pass of the sanitiser: basename, no control chars, no traversal. */
function scrubName(value) {
  const flattened = String(value ?? '').replace(/\\/g, '/');
  const base = path.posix.basename(flattened).trim();
  const cleaned = base
    .replace(CONTROL_CHARS, '')
    .replace(HOSTILE_CHARS, '_')
    // A leading dash makes the file look like a flag to the next command.
    .replace(/^-+/, '_')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned.length > 200 ? truncateMiddle(cleaned) : cleaned;
}

/**
 * A filename off the network is untrusted: it must not escape the download
 * directory, and must not be empty.
 *
 * The fallback is untrusted too — callers build it out of server-supplied
 * ids ("transfer-<id>.bin"), so it goes through the same scrubber. Returning
 * it raw was a path traversal: a transfer_id of "x/../../PWNED" wrote the
 * file outside the download directory.
 *
 * @param {string|null|undefined} name
 * @param {string} fallback
 */
export function safeFileName(name, fallback = LAST_RESORT_NAME) {
  return scrubName(name) || scrubName(fallback) || LAST_RESORT_NAME;
}

/**
 * A server-supplied id, reduced to something that is safe to paste into a
 * filename. Anything outside [A-Za-z0-9._-] goes, and a leading dot cannot
 * survive either, so the result can never be "..", "/etc/passwd" or
 * "x/../../escape".
 *
 * @param {string|null|undefined} id
 * @param {string} fallback used when the id sanitises down to nothing
 */
export function safeIdSegment(id, fallback = 'unknown') {
  const cleaned = String(id ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.]+/, '')
    .slice(0, 64);
  return cleaned || fallback;
}

/**
 * Join a name onto a directory and refuse to hand back anything that escapes
 * it. The last line of defence: every path the receiver opens goes through
 * here, so a traversal that slips past the name scrubbers still cannot write
 * outside the download directory.
 *
 * @param {string} dir
 * @param {string} name
 */
export function resolveInside(dir, name) {
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to write outside ${root}: ${name}`);
  }
  return full;
}

function truncateMiddle(name) {
  const ext = path.extname(name).slice(0, 16);
  return `${path.basename(name, path.extname(name)).slice(0, 180)}${ext}`;
}

/**
 * Open a file for writing without ever overwriting an existing one:
 * `report.pdf`, then `report (2).pdf`, then `report (3).pdf`. Uses O_EXCL, so
 * two watchers racing on the same directory cannot both win the same name.
 *
 * @param {string} dir
 * @param {string} filename already run through safeFileName
 * @returns {{fd:number, filePath:string, name:string}}
 */
export function openWithoutClobbering(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length) || filename;
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = n === 1 ? filename : `${stem} (${n})${ext}`;
    // Containment check, not decoration: `filename` is server-supplied.
    const filePath = resolveInside(dir, candidate);
    try {
      return { fd: fs.openSync(filePath, 'wx', 0o600), filePath, name: candidate };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not find a free filename for ${filename} in ${dir}`);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

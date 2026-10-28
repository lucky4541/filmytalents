import { getSetting } from './settings';
import fs from 'fs';
import path from 'path';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import multer from 'multer';
import type { Request } from 'express';
import { env } from '../config/env';
import { badRequest } from './errors';

/**
 * File storage. Files are saved on the server disk under UPLOAD_DIR and served at /uploads/…
 * To move to S3 / Cloudflare R2 later, only saveFile() and removeFile() need to change.
 */
const root = () => path.resolve(env.UPLOAD_DIR);

/* ---------- Private files (ID / KYC documents) ----------
 * Files under /uploads/kyc/ are NOT public. The API only hands out links signed with SECRETS_KEY
 * that stop working after KYC_LINK_MINUTES, and only to admins or the member who uploaded them. */
const KYC_LINK_MINUTES = 10;
const kycSig = (p: string, exp: number) => createHmac('sha256', env.SECRETS_KEY).update(`${p}|${exp}`).digest('hex').slice(0, 32);
export function signKycUrl(url: string): string {
  const i = url.indexOf('/uploads/kyc/');
  if (i < 0) return url;
  const bare = url.split('?')[0];
  const p = bare.slice(i + '/uploads'.length); // "/kyc/<user>/<file>"
  const exp = Math.floor(Date.now() / 1000) + KYC_LINK_MINUTES * 60;
  return `${bare}?exp=${exp}&sig=${kycSig(p, exp)}`;
}
export function signDocs<T extends { docs: { label: string; url: string }[] }>(row: T): T {
  return { ...row, docs: row.docs.map((d) => ({ ...d, url: signKycUrl(d.url) })) };
}
/** Checks a signed link. `p` is the path below /uploads, e.g. "/kyc/<user>/<file>". */
export function kycLinkOk(p: string, exp: unknown, sig: unknown): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000 || typeof sig !== 'string') return false;
  const want = Buffer.from(kycSig(p, e)); const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const VIDEO_TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
const DOC_TYPES: Record<string, string> = { ...PHOTO_TYPES, 'application/pdf': '.pdf' };

export type FileKind = 'photo' | 'video' | 'doc';
const typesFor = (k: FileKind) => (k === 'photo' ? PHOTO_TYPES : k === 'video' ? VIDEO_TYPES : DOC_TYPES);

/** Checks the first bytes of the file so a renamed .exe can't pass as a photo. */
function looksLike(buf: Buffer, mime: string) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (mime === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (mime === 'image/png') return hex.startsWith('89504e47');
  if (mime === 'image/webp') return hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP';
  if (mime === 'application/pdf') return buf.subarray(0, 4).toString() === '%PDF';
  if (mime === 'video/webm') return hex.startsWith('1a45dfa3');
  if (mime === 'video/mp4' || mime === 'video/quicktime') return buf.subarray(4, 8).toString() === 'ftyp';
  return false;
}

/** Multer in memory; the file is checked, then written by saveFile(). */
export function uploader(kind: FileKind, maxFiles = 1) {
  // Hard cap; the admin's limit (Settings → Uploads) is checked in saveFile.
  const maxMb = Math.max(kind === 'video' ? env.MAX_VIDEO_MB : env.MAX_PHOTO_MB, kind === 'video' ? 200 : 25);
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: maxFiles },
    fileFilter: (_req, file, cb) => {
      if (!typesFor(kind)[file.mimetype]) return cb(badRequest(kind === 'photo' ? 'Upload a JPG, PNG or WEBP photo' : kind === 'video' ? 'Upload an MP4, MOV or WEBM video' : 'Upload a photo or PDF'));
      cb(null, true);
    },
  });
}

/** Saves an uploaded file and returns its public URL. */
export async function saveFile(file: Express.Multer.File | undefined, kind: FileKind, folder: string) {
  if (!file) throw badRequest('Choose a file to upload');
  const ext = typesFor(kind)[file.mimetype];
  if (!ext || !looksLike(file.buffer, file.mimetype)) throw badRequest('This file looks damaged or is not the right type');
  if (kind !== 'doc') {
    const u = await getSetting<{ maxPhotoMb?: number; maxVideoMb?: number }>('uploads', {});
    const mb = kind === 'video' ? (u.maxVideoMb ?? env.MAX_VIDEO_MB) : (u.maxPhotoMb ?? env.MAX_PHOTO_MB);
    if (file.size > mb * 1024 * 1024) throw badRequest(`${kind === 'video' ? 'Videos' : 'Photos'} can be up to ${mb} MB`);
  }
  const dir = path.join(root(), folder);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${randomUUID()}${ext}`;
  await fs.promises.writeFile(path.join(dir, name), file.buffer);
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/uploads/${folder}/${name}`;
}

/** Deletes a file we stored earlier. Ignores URLs that aren't ours. */
export async function removeFile(url: string | null | undefined) {
  if (!url) return;
  const marker = '/uploads/';
  const i = url.indexOf(marker);
  if (i < 0) return;
  const rel = url.slice(i + marker.length);
  const full = path.resolve(root(), rel);
  if (!full.startsWith(root() + path.sep)) return;
  await fs.promises.unlink(full).catch(() => undefined);
}

/** Wraps a multer middleware so it can be awaited inside a route. */
export function runUpload(mw: import('express').RequestHandler, req: Request, res: import('express').Response) {
  return new Promise<void>((resolve, reject) => mw(req, res, (err?: unknown) => (err ? reject(err) : resolve())));
}

import { Router } from 'express';
import { ah } from '../../lib/http';
import { badRequest } from '../../lib/errors';
import { runUpload, saveFile, uploader } from '../../lib/storage';
import { audit } from '../../lib/audit';
import { requireAdmin } from '../../middleware/auth';

/** Image uploads from the admin panel (casting posters, home banners, plan images). Form field: "file". */
export const adminUploads = Router();
adminUploads.use(requireAdmin);

const FOLDERS = ['posters', 'banners', 'site'] as const;

adminUploads.post('/:folder', ah(async (req, res) => {
  const folder = req.params.folder as (typeof FOLDERS)[number];
  if (!FOLDERS.includes(folder)) throw badRequest(`Folder must be one of: ${FOLDERS.join(', ')}`);
  await runUpload(uploader('photo').single('file'), req, res);
  if (!req.file) throw badRequest('Choose an image to upload');
  const url = await saveFile(req.file, 'photo', `admin/${folder}`);
  await audit(req, 'uploads', `Uploaded image to ${folder}`, url.split('/').pop() ?? '');
  res.status(201).json({ url });
}));

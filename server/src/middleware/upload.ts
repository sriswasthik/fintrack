/**
 * Multer configuration for CSV uploads.
 *
 * Memory storage: an export is small, the parse is synchronous, and nothing is
 * written to the database from the upload route anyway — so there is no reason
 * to put a user's bank data on disk.
 */
import multer from 'multer';

/** Generous for a bank export, small enough not to be a memory risk. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ACCEPTED_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel', // what several browsers send for a .csv
  'application/octet-stream',
]);

export const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    const looksLikeCsv =
      ACCEPTED_MIME_TYPES.has(file.mimetype) || /\.csv$/i.test(file.originalname ?? '');
    if (!looksLikeCsv) {
      callback(new Error('Only .csv files can be uploaded'));
      return;
    }
    callback(null, true);
  },
});

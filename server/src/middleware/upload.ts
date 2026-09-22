/**
 * Multer configuration for statement uploads.
 *
 * Memory storage: an export is small, the parse is synchronous, and nothing is
 * written to the database from the upload route anyway — so there is no reason
 * to put a user's bank data on disk.
 */
import multer from 'multer';

/**
 * Raised by a file filter when the upload is not a type this route reads.
 *
 * A class rather than a message the error handler string-matches on: the
 * handler used to compare against the exact CSV wording, which meant adding a
 * second accepted file type silently turned its rejection into a 500.
 */
export class UnsupportedFileTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFileTypeError';
  }
}

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
      callback(new UnsupportedFileTypeError('Only .csv files can be uploaded'));
      return;
    }
    callback(null, true);
  },
});

const PDF_MIME_TYPES = new Set([
  'application/pdf',
  'application/x-pdf',
  'application/octet-stream',
]);

/**
 * PDF statements.
 *
 * A larger ceiling than the CSV path: a scanned statement carries fonts and
 * images a CSV does not, and being refused for size after choosing the right
 * file is a bad way to learn the limit.
 */
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

/**
 * How many statements one batch import may carry.
 *
 * A quarter is three; a custom range over two years is twenty-four. Past that
 * it is not a range, and each file is a PDF parse holding a buffer in memory.
 */
export const MAX_BATCH_FILES = 24;

export const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: MAX_BATCH_FILES },
  fileFilter: (_req, file, callback) => {
    const looksLikePdf =
      PDF_MIME_TYPES.has(file.mimetype) || /\.pdf$/i.test(file.originalname ?? '');
    if (!looksLikePdf) {
      callback(new UnsupportedFileTypeError('Only .pdf files can be uploaded here'));
      return;
    }
    callback(null, true);
  },
});

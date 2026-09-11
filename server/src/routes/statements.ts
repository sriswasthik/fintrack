import { Router } from 'express';

import {
  inspectStatement,
  parseStatement,
  parseStatementBatch,
} from '../controllers/statements';
import { asyncHandler } from '../middleware/errorHandler';
import { uploadLimiter } from '../middleware/rateLimit';
import { MAX_BATCH_FILES, pdfUpload } from '../middleware/upload';

export const statementsRouter = Router();

/**
 * Does this PDF need a password? Cheap, writes nothing, and needs no password
 * itself — it exists so the client only asks for one when there is one to ask
 * for.
 */
statementsRouter.post(
  '/statements/inspect',
  uploadLimiter,
  pdfUpload.single('file'),
  asyncHandler(inspectStatement),
);

/** Read the statement into the same preview a CSV upload produces. */
statementsRouter.post(
  '/statements/parse',
  uploadLimiter,
  pdfUpload.single('file'),
  asyncHandler(parseStatement),
);

/**
 * Several statements as one import — a quarter, or any range the user picked.
 * Duplicate detection runs across the whole batch, which is the point of it.
 */
statementsRouter.post(
  '/statements/parse-batch',
  uploadLimiter,
  pdfUpload.array('files', MAX_BATCH_FILES),
  asyncHandler(parseStatementBatch),
);

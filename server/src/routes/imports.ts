import { Router } from 'express';

import { listImports, undoImport } from '../controllers/imports';
import { asyncHandler } from '../middleware/errorHandler';

export const importsRouter = Router();

importsRouter.get('/imports', asyncHandler(listImports));
importsRouter.delete('/imports/:id', asyncHandler(undoImport));

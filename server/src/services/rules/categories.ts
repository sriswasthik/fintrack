import { Category } from '../../generated/prisma/enums';

/**
 * The taxonomy as a tuple, for Zod enums and for the client's category pickers.
 * Derived from the generated Prisma enum so it can never drift from the schema.
 */
export const CATEGORIES = Object.values(Category) as [Category, ...Category[]];

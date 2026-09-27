/**
 * PDF statement reading.
 *
 * Two jobs, deliberately separated, because they answer to different moments in
 * the user's flow:
 *
 *   * `inspectPdf` answers one question — does this file need a password? — and
 *     answers it *before* anyone is asked to type one. Most statements are not
 *     encrypted, and a password box shown to somebody who does not need one is
 *     a box they will assume they are failing at.
 *   * `extractPdfText` does the actual reading, and only then.
 *
 * Text comes back with coordinates rather than as a string. A statement is a
 * table, and a table is only a table because of where things sit: the reader
 * downstream reconstructs rows from y and columns from x. Flattening to text
 * first would throw away the only structure the file has.
 */
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  TextItem as PdfJsTextItem,
} from 'pdfjs-dist/types/src/display/api';

/** A PDF that is encrypted, presented without a password. */
export class PasswordRequiredError extends Error {
  readonly code = 'PASSWORD_REQUIRED';
  constructor(message = 'This statement is password-protected') {
    super(message);
    this.name = 'PasswordRequiredError';
  }
}

/** A PDF that is encrypted, presented with the wrong password. */
export class IncorrectPasswordError extends Error {
  readonly code = 'INCORRECT_PASSWORD';
  constructor(message = 'That password did not open the statement') {
    super(message);
    this.name = 'IncorrectPasswordError';
  }
}

/** A PDF that pdf.js could not read at all — truncated, corrupt, not a PDF. */
export class UnreadablePdfError extends Error {
  readonly code = 'UNREADABLE_PDF';
  constructor(message = 'This file could not be read as a PDF') {
    super(message);
    this.name = 'UnreadablePdfError';
  }
}

/** One run of text, with where it sits on the page. */
export interface PdfTextItem {
  text: string;
  /** Points from the left edge. */
  x: number;
  /** Points from the *bottom* edge, which is how PDF measures it. */
  y: number;
  width: number;
  height: number;
}

export interface PdfPage {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

export type TextItemsByPage = PdfPage[];

/**
 * pdf.js ships as ESM only. The server compiles to CommonJS, where a dynamic
 * import is the way in — TypeScript preserves it under `module: nodenext`
 * rather than rewriting it to a `require` that would fail on an ESM package.
 *
 * Loaded once and reused: the first import is slow enough to notice.
 */
type PdfJs = typeof PdfJsModule;
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

interface OpenDocument {
  document: PDFDocumentProxy;
  /** Releasing the document means destroying the task that produced it. */
  task: PDFDocumentLoadingTask;
}

/**
 * Opens a document, translating pdf.js's exceptions into ours.
 *
 * The buffer is copied because pdf.js takes ownership of what it is handed and
 * leaves the original detached — which matters here, since `inspectPdf` and
 * `extractPdfText` are called one after the other on the same upload.
 */
async function open(buffer: Buffer, password?: string): Promise<OpenDocument> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    password,
    useSystemFonts: false,
    // Silence pdf.js's own console chatter about fonts it cannot map.
    verbosity: 0,
  });

  try {
    return { document: await task.promise, task };
  } catch (error) {
    // The task holds a worker even when the promise rejected.
    await task.destroy().catch(() => undefined);

    if (error instanceof pdfjs.PasswordException) {
      throw error.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD
        ? new IncorrectPasswordError()
        : new PasswordRequiredError();
    }
    if (error instanceof pdfjs.InvalidPDFException) {
      throw new UnreadablePdfError();
    }
    throw error;
  }
}

/**
 * Does this file need a password?
 *
 * Deliberately does no parsing: it opens the document far enough to learn
 * whether it is encrypted and then puts it down. That is the whole question the
 * client needs answered before it decides whether to show a password field.
 */
export async function inspectPdf(buffer: Buffer): Promise<{ requiresPassword: boolean }> {
  try {
    const { task } = await open(buffer);
    await task.destroy();
    return { requiresPassword: false };
  } catch (error) {
    if (error instanceof PasswordRequiredError || error instanceof IncorrectPasswordError) {
      return { requiresPassword: true };
    }
    throw error;
  }
}

/** True for the text-bearing items; pdf.js also emits marked-content markers. */
function isTextItem(item: unknown): item is PdfJsTextItem {
  return typeof (item as PdfJsTextItem).str === 'string';
}

/**
 * Every text run in the document, page by page, with its position.
 *
 * Throws `PasswordRequiredError` when the file is encrypted and no password was
 * given, and `IncorrectPasswordError` when one was given and is wrong. The
 * caller needs to tell those apart: one asks for input, the other says the
 * input was wrong, and answering the second with the first is how a person ends
 * up typing the same wrong password three times.
 */
export async function extractPdfText(buffer: Buffer, password?: string): Promise<TextItemsByPage> {
  const { document, task } = await open(buffer, password);

  try {
    const pages: PdfPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const items: PdfTextItem[] = content.items.filter(isTextItem).flatMap((item) => {
        const text = item.str.trim();
        if (!text) return [];
        // transform is [a, b, c, d, e, f]; e and f are the translation, which
        // is where on the page this run starts.
        const [, , , , x, y] = item.transform as number[];
        return [{ text, x, y, width: item.width, height: item.height }];
      });

      pages.push({ pageNumber, width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }

    return pages;
  } finally {
    await task.destroy();
  }
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useLang } from '@/i18n';
import { ZoomFrame } from './ZoomFrame';

/** the bytes behind a base64 data URL */
export function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const binary = atob(comma < 0 ? '' : dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
}

/** pdf.js arrives only when an invoice is opened (the type import above costs nothing); its worker is a bundled asset */
async function openPdf(dataUrl: string): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return pdfjs.getDocument({ data: dataUrlBytes(dataUrl) }).promise;
}

/** a page's size at scale 1, in PDF points */
interface PageSize {
  width: number;
  height: number;
}

/** every page at the frame's width × the zoom, sharp for the device's pixel ratio */
function PdfPages({
  doc,
  sizes,
  width,
  testId,
  onFail,
}: Readonly<{ doc: PDFDocumentProxy; sizes: readonly PageSize[]; width: number; testId: string; onFail: () => void }>) {
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  useEffect(() => {
    if (width <= 0) return;
    let alive = true;
    const tasks: RenderTask[] = [];
    const dpr = globalThis.devicePixelRatio || 1;
    const draw = async () => {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: (width / sizes[n - 1].width) * dpr });
        const canvas = canvases.current[n - 1];
        if (!alive || !canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) continue;
        const task = page.render({ canvasContext: context, canvas, viewport });
        tasks.push(task);
        await task.promise;
      }
    };
    draw().catch(() => {
      if (alive) onFail();
    });
    return () => {
      // a zoom while the pages draw: the running render stands down (pdf.js refuses two on one canvas)
      alive = false;
      for (const task of tasks) task.cancel?.();
    };
  }, [doc, sizes, width, onFail]);
  // the layout follows the zoom at once (the sizes are known); the pixels follow when drawn
  return sizes.map((size, i) => (
    <canvas
      key={`${testId}-${i + 1}`}
      ref={(el) => {
        canvases.current[i] = el;
      }}
      data-testid={`${testId}-page-${i + 1}`}
      className="bg-white shadow-sm"
      style={{ width: Math.floor(width), height: Math.floor((width * size.height) / size.width) }}
    />
  ));
}

/**
 * The invoice drawn by pdf.js (user 2026-10-06): every page as wide as the
 * frame, so the reader only scrolls down; the shared zoom frame zooms in
 * and out (up to 4×, never under the width — #568 added the double tap,
 * the mouse drag and the zoom around its point). The browser's own PDF
 * plugin was the previous answer - it fit the page instead of the width,
 * zoomed as it pleased, and Android had none at all.
 */
export function PdfView({ dataUrl, testId }: Readonly<{ dataUrl: string; testId: string }>) {
  const { t } = useLang();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setSizes([]);
    setFailed(false);
    openPdf(dataUrl)
      .then(async (opened) => {
        const pages = await Promise.all(Array.from({ length: opened.numPages }, async (_, i) => (await opened.getPage(i + 1)).getViewport({ scale: 1 })));
        if (!alive) return;
        setSizes(pages.map((page) => ({ width: page.width, height: page.height })));
        setDoc(opened);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [dataUrl]);

  const pageCount = doc?.numPages ?? 0;
  let status = t('receipts.pdfLoading');
  if (pageCount > 0) status = t('receipts.pageCount', { n: pageCount });
  else if (failed) status = t('receipts.pdfFailed');
  return (
    <ZoomFrame testId={testId} status={status}>
      {(width) => doc && <PdfPages doc={doc} sizes={sizes} width={width} testId={testId} onFail={fail} />}
    </ZoomFrame>
  );
}

// src/utils/buildAnnotatedPdf.js
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

function viewportRectToPdfRect(r, pageHeight) {
  return {
    x: r.x,
    y: pageHeight - r.y - r.height,
    width: r.width,
    height: r.height,
  };
}

function scaledRectToPdfRect(r, pageWidth, pageHeight) {
  const x = (r.x / 100) * pageWidth;
  const width = (r.width / 100) * pageWidth;

  const yTop = (r.y / 100) * pageHeight;
  const height = (r.height / 100) * pageHeight;

  return {
    x,
    y: pageHeight - yTop - height,
    width,
    height,
  };
}

function rectFromShape(r) {
  if (!r) return null;

  if (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number"
  ) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  if (
    typeof r.x1 === "number" &&
    typeof r.y1 === "number" &&
    typeof r.x2 === "number" &&
    typeof r.y2 === "number"
  ) {
    return {
      x: r.x1,
      y: r.y1,
      width: r.x2 - r.x1,
      height: r.y2 - r.y1,
    };
  }

  return null;
}

function normalizeHighlight(h) {
  if (!h) return null;

  // do not export temporary live-reader highlight
  if (h.kind === "live-reader" || h.id === "__live_reader__") {
    return null;
  }

  if (typeof h.pageNumber === "number" && Array.isArray(h.rects)) {
    const rects = h.rects
      .map(rectFromShape)
      .filter(Boolean)
      .filter(
        (r) =>
          r.width > 0 &&
          r.height > 0 &&
          [r.x, r.y, r.width, r.height].every(Number.isFinite)
      );

    if (!rects.length) return null;

    return {
      pageNumber: h.pageNumber,
      rects,
      rectType: "viewport",
      note: h.note || h.comment?.text || h.comment || "",
    };
  }

  // prefer scaledPosition because it is the most stable for export
  if (h.scaledPosition?.pageNumber) {
    const pos = h.scaledPosition;

    let rects = [];
    if (Array.isArray(pos.rects) && pos.rects.length) rects = pos.rects;
    else if (pos.boundingRect) rects = [pos.boundingRect];

    rects = rects
      .map(rectFromShape)
      .filter(Boolean)
      .filter(
        (r) =>
          r.width > 0 &&
          r.height > 0 &&
          [r.x, r.y, r.width, r.height].every(Number.isFinite)
      );

    if (!rects.length) return null;

    return {
      pageNumber: pos.pageNumber,
      rects,
      rectType: "scaled",
      note: h.note || h.comment?.text || h.comment || "",
    };
  }

  if (h.position?.pageNumber) {
    const pos = h.position;

    let rects = [];
    if (Array.isArray(pos.rects) && pos.rects.length) rects = pos.rects;
    else if (pos.boundingRect) rects = [pos.boundingRect];

    rects = rects
      .map(rectFromShape)
      .filter(Boolean)
      .filter(
        (r) =>
          r.width > 0 &&
          r.height > 0 &&
          [r.x, r.y, r.width, r.height].every(Number.isFinite)
      );

    if (!rects.length) return null;

    return {
      pageNumber: pos.pageNumber,
      rects,
      rectType: "viewport",
      note: h.note || h.comment?.text || h.comment || "",
    };
  }

  return null;
}

export async function buildAnnotatedPdf(pdfBytes, highlights = []) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pageCount = pdfDoc.getPageCount();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const byPage = new Map();

  for (const raw of highlights) {
    const h = normalizeHighlight(raw);
    if (!h) continue;

    // react-pdf-highlighter page numbers are 1-based
    const pageIndex = h.pageNumber - 1;

    if (pageIndex < 0 || pageIndex >= pageCount) continue;

    if (!byPage.has(pageIndex)) byPage.set(pageIndex, []);
    byPage.get(pageIndex).push(h);
  }

  for (const [pageIndex, hs] of byPage.entries()) {
    const page = pdfDoc.getPage(pageIndex);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    for (const h of hs) {
      for (const r of h.rects) {
        const pr =
          h.rectType === "scaled"
            ? scaledRectToPdfRect(r, pageWidth, pageHeight)
            : viewportRectToPdfRect(r, pageHeight);

        if (
          !Number.isFinite(pr.x) ||
          !Number.isFinite(pr.y) ||
          !Number.isFinite(pr.width) ||
          !Number.isFinite(pr.height) ||
          pr.width <= 0 ||
          pr.height <= 0
        ) {
          continue;
        }

        page.drawRectangle({
          x: pr.x,
          y: pr.y,
          width: pr.width,
          height: pr.height,
          color: rgb(1, 1, 0),
          opacity: 0.28,
          borderWidth: 0,
        });
      }

      if (h.note && h.rects.length > 0) {
        const first = h.rects[0];
        const pr0 =
          h.rectType === "scaled"
            ? scaledRectToPdfRect(first, pageWidth, pageHeight)
            : viewportRectToPdfRect(first, pageHeight);

        page.drawText(String(h.note).slice(0, 160), {
          x: pr0.x,
          y: Math.min(pageHeight - 14, pr0.y + pr0.height + 4),
          size: 10,
          font,
          color: rgb(0.1, 0.1, 0.1),
          maxWidth: Math.max(80, pageWidth - pr0.x - 20),
        });
      }
    }
  }

  return await pdfDoc.save();
}
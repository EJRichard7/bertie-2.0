import React, { useEffect, useMemo, useRef } from "react";
import { PdfLoader, PdfHighlighter, Tip, Highlight, Popup } from "react-pdf-highlighter";

export default function PdfAnnotator({
  pdfFile,
  highlights,
  onAddHighlight,
  onSelectHighlight,
  selectedHighlightId,

  voiceIntent,
  onConsumedVoiceIntent,
  onPendingSelectionChange,

  autoHighlightText,
  autoHighlightNonce,
  autoHighlightPage,
  onAutoHighlightConsumed,
}) {
  const containerRef = useRef(null);
  const scrollToRef = useRef(null);
  const pendingSelectionRef = useRef(null);
  const autoHighlightArmedRef = useRef(false);

  const selectedHighlight = useMemo(() => {
    if (!selectedHighlightId) return null;
    return highlights?.find((h) => h.id === selectedHighlightId) || null;
  }, [highlights, selectedHighlightId]);

  useEffect(() => {
    if (!selectedHighlight) return;
    if (!scrollToRef.current) return;
    try {
      scrollToRef.current(selectedHighlight);
    } catch {}
  }, [selectedHighlight]);

  useEffect(() => {
    if (voiceIntent !== "highlight") return;

    const pending = pendingSelectionRef.current;
    if (!pending) {
      onConsumedVoiceIntent?.();
      return;
    }

    onAddHighlight?.(pending);
    pendingSelectionRef.current = null;
    onPendingSelectionChange?.(false);
    onConsumedVoiceIntent?.();
  }, [voiceIntent, onAddHighlight, onConsumedVoiceIntent, onPendingSelectionChange]);

  // -------- robust matching helpers --------
  function norm(s) {
    return (s || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/-\s+/g, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[^a-zA-Z0-9 ]/g, "")
      .trim()
      .toLowerCase();
  }

  function buildJoined(spans) {
    const texts = spans.map((sp) => sp.textContent || "");
    let joined = "";
    const map = [];

    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];

      if (joined.length > 0) {
        const prevCh = joined[joined.length - 1];
        const nextCh = t[0];
        const needSpace =
          prevCh && nextCh && /[A-Za-z0-9]/.test(prevCh) && /[A-Za-z0-9]/.test(nextCh);

        if (needSpace) {
          map.push({ spanI: i, offset: 0, isVirtualSpace: true });
          joined += " ";
        }
      }

      for (let j = 0; j < t.length; j++) {
        map.push({ spanI: i, offset: j, isVirtualSpace: false });
        joined += t[j];
      }
    }

    return { texts, joined, map };
  }

  function tryFind(sentence) {
    const root = containerRef.current;
    if (!root) return null;

    const spans = Array.from(root.querySelectorAll(".textLayer span"));
    if (!spans.length) return null;

    const { joined, map } = buildJoined(spans);
    const joinedNorm = norm(joined);

    const candidates = [
      sentence,
      (sentence || "").slice(0, 140),
      (sentence || "").slice(0, 100),
      (sentence || "").slice(0, 80),
    ]
      .map((c) => norm(c))
      .filter((c) => c && c.length >= 20);

    let idx = -1;
    let key = "";

    for (const k of candidates) {
      const i = joinedNorm.indexOf(k);
      if (i >= 0) {
        idx = i;
        key = k;
        break;
      }
    }

    if (idx < 0) return null;

    // raw->norm mapping (approx)
    const raw = joined.replace(/\u00a0/g, " ");
    const rawToNorm = [];
    let normStr = "";

    for (let r = 0; r < raw.length; r++) {
      const ch = raw[r].toLowerCase();

      if (!/[a-z0-9 ]/.test(ch)) continue;

      if (/\s/.test(ch)) {
        if (!normStr.endsWith(" ")) {
          normStr += " ";
          rawToNorm.push(r);
        }
        continue;
      }

      normStr += ch;
      rawToNorm.push(r);
    }

    const startRaw = rawToNorm[idx] ?? 0;
    const endRaw =
      rawToNorm[Math.min(idx + key.length - 1, rawToNorm.length - 1)] ?? raw.length - 1;

    return { spans, map, startRaw, endRaw: endRaw + 1 };
  }

  function makeRangeFromRawIndices(found) {
    const { spans, map, startRaw, endRaw } = found;

    const start = map[startRaw];
    const end = map[Math.max(0, Math.min(endRaw - 1, map.length - 1))];
    if (!start || !end) return null;

    const startSpan = spans[start.spanI];
    const endSpan = spans[end.spanI];

    const range = document.createRange();
    range.setStart(startSpan.firstChild || startSpan, start.offset);
    range.setEnd(endSpan.firstChild || endSpan, end.offset + 1);
    return range;
  }

  useEffect(() => {
    if (!autoHighlightText) return;

    autoHighlightArmedRef.current = true;

    let cancelled = false;

    (async () => {
      // ✅ Ensure the page is rendered by scrolling it into view first
      const pageEl = containerRef.current?.querySelector(
        `.page[data-page-number="${autoHighlightPage}"]`
      );
      pageEl?.scrollIntoView({ block: "center" });

      // give it time to render the textLayer after scrolling
      for (const wait of [120, 250, 450, 700, 1000]) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, wait));

        const found = tryFind(autoHighlightText);
        if (!found) continue;

        const range = makeRangeFromRawIndices(found);
        if (!range) continue;

        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);

        containerRef.current?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }

      autoHighlightArmedRef.current = false;
      onAutoHighlightConsumed?.(false);
    })();

    const failSafe = setTimeout(() => {
      if (autoHighlightArmedRef.current) {
        autoHighlightArmedRef.current = false;
        onAutoHighlightConsumed?.(false);
      }
    }, 2500);

    return () => {
      cancelled = true;
      clearTimeout(failSafe);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHighlightNonce]);

  return (
    <div style={{ marginTop: 20 }}>
      <div
        ref={containerRef}
        style={{
          height: "70vh",
          border: "1px solid #ccc",
          borderRadius: 8,
          overflow: "hidden",
          background: "white",
        }}
      >
        <PdfLoader url={pdfFile} beforeLoad={<div>Loading PDF…</div>}>
          {(pdfDocument) => (
            <PdfHighlighter
              pdfDocument={pdfDocument}
              pdfScaleValue="page-width"
              scrollRef={(scrollTo) => (scrollToRef.current = scrollTo)}
              onSelectionFinished={(position, content, hideTip, transformSelection) => {
                pendingSelectionRef.current = { position, content };
                onPendingSelectionChange?.(true);

                if (autoHighlightArmedRef.current) {
                  autoHighlightArmedRef.current = false;

                  onAddHighlight?.({ position, content });
                  pendingSelectionRef.current = null;
                  onPendingSelectionChange?.(false);

                  hideTip();
                  transformSelection();

                  onAutoHighlightConsumed?.(true);
                  return null;
                }

                return (
                  <Tip
                    onConfirm={() => {
                      onAddHighlight?.({ position, content });
                      pendingSelectionRef.current = null;
                      onPendingSelectionChange?.(false);
                      hideTip();
                      transformSelection();
                    }}
                  >
                    <button>Highlight</button>
                  </Tip>
                );
              }}
              highlightTransform={(highlight, _, setTip, hideTip, __, ___, isScrolledTo) => (
                <Popup
                  key={highlight.id}
                  popupContent={<div>{highlight.note ? highlight.note : "Highlight"}</div>}
                  onMouseOver={(content) => setTip(highlight, () => content)}
                  onMouseOut={hideTip}
                >
                  <div
                    onClick={() => onSelectHighlight?.(highlight.id)}
                    style={{
                      outline: highlight.id === selectedHighlightId ? "2px solid blue" : "none",
                      cursor: "pointer",
                    }}
                  >
                    <Highlight isScrolledTo={isScrolledTo} position={highlight.position} />
                  </div>
                </Popup>
              )}
              highlights={highlights}
            />
          )}
        </PdfLoader>
      </div>
    </div>
  );
}
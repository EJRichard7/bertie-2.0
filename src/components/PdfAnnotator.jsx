import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  PdfLoader,
  PdfHighlighter,
  Tip,
  Highlight,
  Popup,
} from "react-pdf-highlighter";

const LIVE_ID = "__live_reader__";

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

  // temporary follow-along highlight: shown in viewer, never saved to parent
  const [liveHighlight, setLiveHighlight] = useState(null);

  const selectedHighlight = useMemo(() => {
    if (!selectedHighlightId) return null;

    if (liveHighlight?.id === selectedHighlightId) return liveHighlight;
    return highlights?.find((h) => h.id === selectedHighlightId) || null;
  }, [highlights, selectedHighlightId, liveHighlight]);

  useEffect(() => {
    if (!selectedHighlight) return;
    if (!scrollToRef.current) return;

    try {
      scrollToRef.current(selectedHighlight);
    } catch (err) {
      console.warn("Could not scroll to selected highlight:", err);
    }
  }, [selectedHighlight]);

  useEffect(() => {
    if (!pdfFile) {
      pendingSelectionRef.current = null;
      autoHighlightArmedRef.current = false;
      setLiveHighlight(null);
      onPendingSelectionChange?.(false);
    }
  }, [pdfFile, onPendingSelectionChange]);

  useEffect(() => {
  if (voiceIntent !== "highlight") return;

  const pending =
    pendingSelectionRef.current ||
    (liveHighlight
      ? {
          position: liveHighlight.position,
          content: liveHighlight.content,
        }
      : null);

  if (!pending) {
    onConsumedVoiceIntent?.();
    return;
  }

  onAddHighlight?.(pending);
  pendingSelectionRef.current = null;
  onPendingSelectionChange?.(false);
  onConsumedVoiceIntent?.();
}, [
  voiceIntent,
  onAddHighlight,
  onConsumedVoiceIntent,
  onPendingSelectionChange,
  liveHighlight,
]);
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
          prevCh &&
          nextCh &&
          /[A-Za-z0-9]/.test(prevCh) &&
          /[A-Za-z0-9]/.test(nextCh);

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

    return { joined, map };
  }

  function buildRawToNormMap(raw) {
    const rawToNorm = [];
    let normStr = "";

    for (let r = 0; r < raw.length; r++) {
      const ch = raw[r].toLowerCase();

      if (!/[a-z0-9 ]/.test(ch) && !/\s/.test(ch)) continue;

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

    return { rawToNorm, normStr };
  }

  function getAllTextSpans(pageNumber) {
    const root = containerRef.current;
    if (!root) return [];

    const all = Array.from(root.querySelectorAll(".textLayer span")).filter(
      (sp) => (sp.textContent || "").trim().length > 0
    );

    if (!pageNumber) return all;

    const pageMatches = all.filter((sp) => {
      const pageEl =
        sp.closest("[data-page-number]") ||
        sp.closest(".page");

      if (!pageEl) return false;

      const n = Number(pageEl.getAttribute("data-page-number"));
      return n === Number(pageNumber);
    });

    return pageMatches.length ? pageMatches : all;
  }

  function tryFind(sentence, preferredPage) {
    const spans = getAllTextSpans(preferredPage);
    if (!spans.length) return null;

    const { joined, map } = buildJoined(spans);
    const joinedNorm = norm(joined);

    const candidates = [
      sentence,
      (sentence || "").slice(0, 180),
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

    const raw = joined.replace(/\u00a0/g, " ");
    const { rawToNorm } = buildRawToNormMap(raw);

    const startRaw = rawToNorm[idx] ?? 0;
    const endRaw =
      rawToNorm[Math.min(idx + key.length - 1, rawToNorm.length - 1)] ??
      raw.length - 1;

    return {
      spans,
      map,
      startRaw,
      endRaw: endRaw + 1,
    };
  }

  function makeRangeFromRawIndices(found) {
    const { spans, map, startRaw, endRaw } = found;

    const safeStart = Math.max(0, Math.min(startRaw, map.length - 1));
    const safeEnd = Math.max(0, Math.min(endRaw - 1, map.length - 1));

    const start = map[safeStart];
    const end = map[safeEnd];

    if (!start || !end) return null;

    const startSpan = spans[start.spanI];
    const endSpan = spans[end.spanI];

    if (!startSpan || !endSpan) return null;

    const startNode = startSpan.firstChild || startSpan;
    const endNode = endSpan.firstChild || endSpan;

    try {
      const range = document.createRange();
      range.setStart(startNode, start.offset);
      range.setEnd(endNode, end.offset + 1);
      return range;
    } catch (err) {
      console.warn("Could not build text range:", err);
      return null;
    }
  }

  function selectRange(range) {
    if (!range) return false;

    try {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return true;
    } catch (err) {
      console.warn("Could not select range:", err);
      return false;
    }
  }

  function dispatchSelectionMouseUp() {
    try {
      containerRef.current?.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true })
      );
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    if (!autoHighlightText) return;

    autoHighlightArmedRef.current = true;
    let cancelled = false;

    (async () => {
      const waits = [120, 250, 450, 700, 1000, 1400];

      for (const wait of waits) {
        if (cancelled) return;

        await new Promise((r) => setTimeout(r, wait));
        if (cancelled) return;

        const found = tryFind(autoHighlightText, autoHighlightPage);
        if (!found) continue;

        const range = makeRangeFromRawIndices(found);
        if (!range) continue;

        const selected = selectRange(range);
        if (!selected) continue;

        dispatchSelectionMouseUp();
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
    }, 2600);

    return () => {
      cancelled = true;
      clearTimeout(failSafe);
    };
  }, [
    autoHighlightNonce,
    autoHighlightText,
    autoHighlightPage,
    onAutoHighlightConsumed,
  ]);

  const renderedHighlights = liveHighlight
    ? [...highlights, liveHighlight]
    : highlights;

  return (
    <div style={{ marginTop: 20 }}>
      <div
        ref={containerRef}
        style={{
          height: "70vh",
          border: "1px solid #ccc",
          borderRadius: 8,
          overflow: "auto",
          background: "white",
        }}
      >
        <PdfLoader url={pdfFile} beforeLoad={<div>Loading PDF…</div>}>
          {(pdfDocument) => (
            <PdfHighlighter
              pdfDocument={pdfDocument}
              pdfScaleValue="page-width"
              scrollRef={(scrollTo) => {
                scrollToRef.current = scrollTo;
              }}
              onSelectionFinished={(
                position,
                content,
                hideTip,
                transformSelection
              ) => {
                pendingSelectionRef.current = { position, content };
                onPendingSelectionChange?.(true);

                // follow-along highlight: TEMPORARY only
                if (autoHighlightArmedRef.current) {
  autoHighlightArmedRef.current = false;

  const liveData = {
    position,
    content,
  };

  setLiveHighlight({
    id: LIVE_ID,
    ...liveData,
    note: "Live reader",
    kind: "live-reader",
  });

  // keep the current sentence available for voice command:
  // "highlight that sentence"
  pendingSelectionRef.current = liveData;
  onPendingSelectionChange?.(true);

  hideTip();
  transformSelection();

  try {
    window.getSelection()?.removeAllRanges();
  } catch {}

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
              highlightTransform={(
                highlight,
                _,
                setTip,
                hideTip,
                __,
                ___,
                isScrolledTo
              ) => {
                const isLive = highlight.id === LIVE_ID || highlight.kind === "live-reader";

                return (
                  <Popup
                    key={highlight.id}
                    popupContent={
                      <div>{isLive ? "Live reader" : highlight.note ? highlight.note : "Highlight"}</div>
                    }
                    onMouseOver={(content) => setTip(highlight, () => content)}
                    onMouseOut={hideTip}
                  >
                    <div
                      onClick={() => {
                        if (!isLive) onSelectHighlight?.(highlight.id);
                      }}
                      style={{
                        outline:
                          !isLive && highlight.id === selectedHighlightId
                            ? "2px solid blue"
                            : "none",
                        cursor: isLive ? "default" : "pointer",
                        opacity: isLive ? 0.65 : 1,
                      }}
                    >
                      <Highlight
                        isScrolledTo={isScrolledTo}
                        position={highlight.position}
                      />
                    </div>
                  </Popup>
                );
              }}
              highlights={renderedHighlights}
            />
          )}
        </PdfLoader>
      </div>
    </div>
  );
}
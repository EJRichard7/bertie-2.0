import { buildAnnotatedPdf } from "./utils/buildAnnotatedPdf";
import { downloadPdfBytes, printPdfBytes } from "./utils/pdfExportPrint";
import React, { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import PdfAnnotator from "./components/PdfAnnotator.jsx";
import VoiceBar from "./components/VoiceBar.jsx";
import { speakText, stopSpeaking } from "./utils/tts.js";

import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

function hasSelectionText() {
  return Boolean(window.getSelection()?.toString()?.trim());
}

function expandSelection(granularity) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;

  try {
    sel.modify("move", "backward", granularity);
    sel.modify("extend", "forward", granularity);

    const txt = sel.toString().trim();
    if (txt.length > 500) {
      sel.modify("move", "backward", "word");
      sel.modify("extend", "forward", granularity);
    }
    return Boolean(sel.toString().trim());
  } catch {
    return false;
  }
}

function getSelectedText() {
  return window.getSelection()?.toString()?.trim() || "";
}

function normalize(text) {
  return (text || "").toLowerCase().trim();
}

function splitIntoSentences(text) {
  const clean = (text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const parts = clean
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"(\[])/g)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 1 && clean.length > 400) {
    const chunked = [];
    let start = 0;
    while (start < clean.length) {
      chunked.push(clean.slice(start, start + 250));
      start += 250;
    }
    return chunked;
  }

  return parts;
}

async function extractPdfSentences(fileUrl) {
  const loadingTask = pdfjsLib.getDocument(fileUrl);
  const pdf = await loadingTask.promise;

  const all = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const pageText = tc.items.map((it) => it.str).join(" ");
    const sentences = splitIntoSentences(pageText);

    for (const s of sentences) {
      if (s.replace(/[^A-Za-z0-9]/g, "").length < 8) continue;
      all.push({ page: p, text: s });
    }
  }

  return { numPages: pdf.numPages, sentences: all };
}

// Date patterns
const MONTH =
  "(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)";

const DATE_REGEXES = [
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(,\\s*\\d{4})?\\b`, "i"),
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
  /\b(19|20)\d{2}\b/,
];

function findDateIn(text) {
  for (const r of DATE_REGEXES) {
    const m = text.match(r);
    if (m) return m[0];
  }
  return null;
}

export default function App() {
  const [pdfFile, setPdfFile] = useState(null);

  const [highlights, setHighlights] = useState([]);
  const [selectedHighlightId, setSelectedHighlightId] = useState(null);

  const [voiceIntent, setVoiceIntent] = useState(null);
  const [hasPendingSelection, setHasPendingSelection] = useState(false);

  const [statusMsg, setStatusMsg] = useState("");

  const [docSentences, setDocSentences] = useState([]);
  const [docIdx, setDocIdx] = useState(0);
  const [docLoading, setDocLoading] = useState(false);
  const [docMode, setDocMode] = useState(false);
  const stopDocRef = useRef(false);

  // Live follow-along mode
  const [followAlong, setFollowAlong] = useState(true);

  // Auto-highlight current reading sentence
  const [autoHighlightText, setAutoHighlightText] = useState("");
  const [autoHighlightNonce, setAutoHighlightNonce] = useState(0);
  const [autoHighlightPage, setAutoHighlightPage] = useState(1);

  // NEW: when the sentence is found automatically,
  // trigger a real saved highlight right after
  const [saveAfterAutoFind, setSaveAfterAutoFind] = useState(false);

  const [pendingAutoNote, setPendingAutoNote] = useState("");

  window.__bertie = window.__bertie || {};
  window.__bertie.highlights = highlights;
  window.__bertie.pdfFile = pdfFile;

  async function onExportAndPrint() {
    try {
      if (!pdfFile) {
        setStatusMsg("Upload a PDF first.");
        return;
      }

      let originalBytes;

      if (pdfFile instanceof File) {
        originalBytes = await pdfFile.arrayBuffer();
      } else {
        const response = await fetch(pdfFile);
        originalBytes = await response.arrayBuffer();
      }

      const annotatedBytes = await buildAnnotatedPdf(originalBytes, highlights);

      downloadPdfBytes(annotatedBytes, "bertie-annotated.pdf");
      printPdfBytes(annotatedBytes);

      setStatusMsg("Exported + opened print dialog.");
    } catch (err) {
      console.error(err);
      setStatusMsg(`Export/print failed: ${err?.message || err}`);
    }
  }

  async function onUploadPdf(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);

    setPdfFile(url);
    setHighlights([]);
    setSelectedHighlightId(null);

    setDocSentences([]);
    setDocIdx(0);
    setDocMode(false);
    stopDocRef.current = true;

    setAutoHighlightText("");
    setAutoHighlightNonce(0);
    setAutoHighlightPage(1);
    setSaveAfterAutoFind(false);

    setStatusMsg(`Loaded: ${file.name} — building sentence list…`);

    setDocLoading(true);
    try {
      const { sentences } = await extractPdfSentences(url);
      setDocSentences(sentences);
      setDocIdx(0);
      setStatusMsg(`Ready. Found ${sentences.length} sentences. Say “Bertie read document”.`);
    } catch (err) {
      console.error(err);
      setStatusMsg("PDF loaded, but sentence extraction failed. Check console.");
      setDocSentences([]);
    } finally {
      setDocLoading(false);
    }
  }

  function addHighlight(h) {
    const highlight = { ...h, id: uuidv4(), note: "" };
    setHighlights((prev) => [highlight, ...prev]);
    setSelectedHighlightId(highlight.id);
    return highlight.id;
  }

  function updateHighlightNote(highlightId, noteText) {
    setHighlights((prev) =>
      prev.map((h) => (h.id === highlightId ? { ...h, note: noteText } : h))
    );
  }

  useEffect(() => {
    if (!pendingAutoNote) return;
    if (!selectedHighlightId) return;

    updateHighlightNote(selectedHighlightId, pendingAutoNote);
    setPendingAutoNote("");
  }, [pendingAutoNote, selectedHighlightId]);

  function syncFollowAlongHighlight(index) {
    if (!followAlong) return;
    if (!docSentences.length) return;

    const sObj = docSentences[index];
    if (!sObj?.text) return;

    setAutoHighlightText(sObj.text);
    setAutoHighlightPage(sObj.page);
    setAutoHighlightNonce((n) => n + 1);
  }

  function clearFollowAlongHighlight() {
    setAutoHighlightText("");
    setSaveAfterAutoFind(false);
  }

  function stopAllReading() {
    stopDocRef.current = true;
    setDocMode(false);
    stopSpeaking();
    clearFollowAlongHighlight();
    setStatusMsg("Stopped reading.");
  }

  function readSelected() {
    const text = getSelectedText();
    if (!text) {
      setStatusMsg("Select text first.");
      return;
    }

    stopDocRef.current = true;
    setDocMode(false);
    clearFollowAlongHighlight();

    speakText(text);
    setStatusMsg("Reading selected text…");
  }

  function readDocument(fromIndex = docIdx) {
    if (!docSentences.length) {
      setStatusMsg("No sentence list yet. Upload a PDF first.");
      return;
    }

    stopDocRef.current = false;
    setDocMode(true);

    let i = Math.max(0, Math.min(fromIndex, docSentences.length - 1));
    setDocIdx(i);

    const loop = () => {
      if (stopDocRef.current) return;

      if (i >= docSentences.length) {
        setDocMode(false);
        clearFollowAlongHighlight();
        setStatusMsg("Finished the document ✅");
        return;
      }

      const s = docSentences[i];
      setDocIdx(i);
      syncFollowAlongHighlight(i);
      setStatusMsg(`Reading ${i + 1}/${docSentences.length} (p.${s.page})`);

      speakText(s.text, () => {
        i += 1;
        loop();
      });
    };

    loop();
  }

  function nextSentence() {
    if (!docSentences.length) return;

    const n = Math.min(docIdx + 1, docSentences.length - 1);
    setDocIdx(n);
    syncFollowAlongHighlight(n);

    if (docMode) {
      stopDocRef.current = true;
      stopSpeaking();
      readDocument(n);
    } else {
      setStatusMsg(`Moved to sentence ${n + 1}. Say “read document” to continue.`);
    }
  }

  function prevSentence() {
    if (!docSentences.length) return;

    const n = Math.max(docIdx - 1, 0);
    setDocIdx(n);
    syncFollowAlongHighlight(n);

    if (docMode) {
      stopDocRef.current = true;
      stopSpeaking();
      readDocument(n);
    } else {
      setStatusMsg(`Moved to sentence ${n + 1}. Say “read document” to continue.`);
    }
  }

  function highlightCurrentSelection() {
    if (!hasPendingSelection) {
      setStatusMsg('Select text first, then say: "Bertie highlight that".');
      return;
    }

    setVoiceIntent("highlight");
    setStatusMsg("Highlighting selection…");
  }

  function highlightSentenceFromSelection() {
    if (!hasSelectionText()) {
      setStatusMsg("Click/drag to select any part of a sentence first.");
      return;
    }

    const ok = expandSelection("sentence");
    if (!ok) {
      setStatusMsg("Couldn’t expand to sentence. Try selecting it manually.");
      return;
    }

    setStatusMsg("Expanded to sentence. Highlighting…");
    setVoiceIntent("highlight");
  }

  function highlightParagraphFromSelection() {
    if (!hasSelectionText()) {
      setStatusMsg("Select any part of a paragraph first.");
      return;
    }

    const ok = expandSelection("paragraph");
    if (!ok) {
      setStatusMsg("Couldn’t expand to paragraph. Try selecting it manually.");
      return;
    }

    setStatusMsg("Expanded to paragraph. Highlighting…");
    setVoiceIntent("highlight");
  }

  function highlightDateFromSelection() {
    if (!hasSelectionText()) {
      setStatusMsg("Select near the date first (any part of the sentence).");
      return;
    }

    const ok = expandSelection("sentence");
    if (!ok) {
      setStatusMsg("Couldn’t expand to the date’s sentence. Try selecting it manually.");
      return;
    }

    const sentenceText = getSelectedText();
    const found = findDateIn(sentenceText);

    setVoiceIntent("highlight");

    if (found) {
      setStatusMsg(`Date found: ${found}. Highlighting sentence + saving note…`);
      setPendingAutoNote(`DATE: ${found}`);
    } else {
      setStatusMsg("No date found in that sentence. Highlighting anyway…");
    }
  }

  function highlightCurrentReadingSentence() {
    if (!docSentences.length) {
      setStatusMsg("Upload a PDF first.");
      return;
    }

    const sObj = docSentences[docIdx];
    if (!sObj?.text) {
      setStatusMsg("No current sentence to highlight.");
      return;
    }

    setStatusMsg(`Finding current sentence (p.${sObj.page})…`);
    setSaveAfterAutoFind(true);
    setAutoHighlightText(sObj.text);
    setAutoHighlightPage(sObj.page);
    setAutoHighlightNonce((n) => n + 1);
  }

  function handleCommand(cmd) {
    if (!cmd?.type) return;

    if (cmd.type === "read") {
      if (hasSelectionText()) readSelected();
      else readDocument(docIdx);
      return;
    }

    if (cmd.type === "stop") {
      stopAllReading();
      return;
    }

    if (cmd.type === "highlight") {
      if (docMode || (cmd.text && normalize(cmd.text).includes("sentence"))) {
        highlightCurrentReadingSentence();
      } else {
        highlightCurrentSelection();
      }
      return;
    }

    if (cmd.type === "note") {
      const note = (cmd.note || "").trim();
      if (!note) {
        setStatusMsg('Try: "Bertie note this is important".');
        return;
      }

      const targetId = selectedHighlightId || highlights?.[0]?.id;
      if (!targetId) {
        setStatusMsg("No highlight to attach a note to yet.");
        return;
      }

      updateHighlightNote(targetId, note);
      setStatusMsg(`Saved note: "${note}"`);
      return;
    }

    if (cmd.type === "unknown") {
      const t = normalize(cmd.text);

      if (t.includes("read") && (t.includes("document") || t.includes("whole"))) {
        readDocument(docIdx);
        return;
      }

      if (t.includes("start over") || t.includes("from the beginning")) {
        readDocument(0);
        return;
      }

      if (t.includes("next sentence") || t === "next") {
        nextSentence();
        return;
      }

      if (t.includes("previous sentence") || t.includes("go back") || t === "back") {
        prevSentence();
        return;
      }

      if (t.includes("highlight") && t.includes("sentence")) {
        highlightCurrentReadingSentence();
        return;
      }

      if (t.includes("highlight") && t.includes("paragraph")) {
        highlightParagraphFromSelection();
        return;
      }

      if (t.includes("highlight") && t.includes("date")) {
        highlightDateFromSelection();
        return;
      }

      setStatusMsg(`Heard (unknown command): "${cmd.text}"`);
    }
  }

  const currentSentence = docSentences[docIdx];

  return (
    <div style={{ padding: 20 }}>
      <h2>PDF Voice Annotator — Bertie 2.0 (Follow Along Reader)</h2>

      <div
        style={{
          marginTop: 12,
          marginBottom: 16,
          padding: 14,
          border: "1px solid #d8d8d8",
          borderRadius: 10,
          background: "#f8f9fb",
          maxWidth: 900,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>How to Use Bertie</div>

        <div style={{ fontSize: 14, marginBottom: 8 }}>
          Bertie lets you read a PDF out loud, move sentence by sentence, and create highlights with your mouse or voice.
        </div>

        <div style={{ fontSize: 14, marginBottom: 6 }}>
          <b>1. Upload a PDF</b> using the file picker.
        </div>

        <div style={{ fontSize: 14, marginBottom: 6 }}>
          <b>2. Read text</b> by selecting part of the PDF and clicking <b>Read selected</b>, or click <b>Read document</b> to have Bertie read the whole document sentence by sentence.
        </div>

        <div style={{ fontSize: 14, marginBottom: 6 }}>
          <b>3. Move through the document</b> with <b>Prev sentence</b> and <b>Next sentence</b>.
        </div>

        <div style={{ fontSize: 14, marginBottom: 6 }}>
          <b>4. Highlight text</b> by selecting text and clicking <b>Highlight selection</b>, or use the sentence / paragraph / date highlight buttons.
        </div>

        <div style={{ fontSize: 14, marginBottom: 6 }}>
          <b>5. Use voice commands</b> by saying <b>"Bertie"</b> and then a command.
        </div>

        <div style={{ fontSize: 14, marginBottom: 6 }}>
          Example commands:
          <div style={{ marginTop: 6, paddingLeft: 16 }}>
            <div>• "Bertie read document"</div>
            <div>• "Bertie stop"</div>
            <div>• "Bertie next sentence"</div>
            <div>• "Bertie go back"</div>
            <div>• "Bertie highlight sentence"</div>
            <div>• "Bertie note this is important"</div>
          </div>
        </div>

        <div style={{ fontSize: 14 }}>
          <b>Follow Along</b> keeps the current sentence highlighted while Bertie reads.
        </div>
      </div>

      <input type="file" accept="application/pdf" onChange={onUploadPdf} />

      <button
        onClick={onExportAndPrint}
        style={{ marginLeft: 12, padding: "6px 12px" }}
      >
        Export + Print PDF
      </button>

      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1000,
          background: "white",
          padding: 10,
          marginTop: 10,
          borderBottom: "1px solid #ddd",
        }}
      >
        <VoiceBar
          wakeWords={["bertie", "berdie", "birdie", "burtie", "thirty", "30"]}
          defaultAlwaysOn={true}
          onFinalTranscript={(text) => setStatusMsg(`Heard: "${text}"`)}
          onCommand={handleCommand}
        />

        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={readSelected}>Read selected</button>

          <button
            disabled={docLoading || !docSentences.length}
            onClick={() => readDocument(docIdx)}
          >
            Read document
          </button>

          <button onClick={stopAllReading}>Stop</button>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={followAlong}
              onChange={(e) => setFollowAlong(e.target.checked)}
            />
            Follow Along
          </label>

          <span style={{ width: 12 }} />

          <button disabled={!docSentences.length} onClick={prevSentence}>
            Prev sentence
          </button>

          <button disabled={!docSentences.length} onClick={nextSentence}>
            Next sentence
          </button>

          <span style={{ width: 12 }} />

          <button disabled={!docSentences.length} onClick={highlightCurrentReadingSentence}>
            Highlight current sentence (Bertie)
          </button>

          <span style={{ width: 12 }} />

          <button onClick={highlightCurrentSelection}>Highlight selection</button>
          <button onClick={highlightSentenceFromSelection}>Highlight sentence (selection)</button>
          <button onClick={highlightDateFromSelection}>Highlight date (selection)</button>
          <button onClick={highlightParagraphFromSelection}>Highlight paragraph (selection)</button>
        </div>

        <div style={{ marginTop: 6, fontSize: 13, color: "#666" }}>
          Try: <b>"Bertie read document"</b> then <b>"Bertie highlight sentence"</b>.
        </div>

        <div style={{ marginTop: 6 }}>
          {statusMsg}

          {docSentences.length ? (
            <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
              Sentence: {docIdx + 1}/{docSentences.length} (p.{currentSentence?.page})
            </div>
          ) : null}

          {docSentences.length ? (
            <div
              style={{
                marginTop: 8,
                padding: 8,
                border: "1px solid #eee",
                borderRadius: 8,
                background: "#fafafa",
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Current sentence</div>
              <div>{currentSentence?.text || "—"}</div>
            </div>
          ) : null}
        </div>
      </div>

      {pdfFile && (
        <PdfAnnotator
          pdfFile={pdfFile}
          highlights={highlights}
          onAddHighlight={addHighlight}
          onSelectHighlight={setSelectedHighlightId}
          selectedHighlightId={selectedHighlightId}
          voiceIntent={voiceIntent}
          onConsumedVoiceIntent={() => setVoiceIntent(null)}
          onPendingSelectionChange={setHasPendingSelection}
          autoHighlightText={autoHighlightText}
          autoHighlightNonce={autoHighlightNonce}
          autoHighlightPage={autoHighlightPage}
          onAutoHighlightConsumed={(ok) => {
            if (!ok) {
              setSaveAfterAutoFind(false);
              setStatusMsg(
                "Couldn’t find that sentence in the PDF text layer (maybe not rendered yet, or PDF text is weird). Try again or use manual highlight."
              );
              return;
            }

            if (saveAfterAutoFind) {
              setVoiceIntent("highlight");
              setSaveAfterAutoFind(false);
              setStatusMsg("Sentence found. Highlighting…");
            }
          }}
        />
      )}
    </div>
  );
}
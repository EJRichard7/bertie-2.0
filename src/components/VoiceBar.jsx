import React, { useEffect, useMemo, useRef, useState } from "react";

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function normalize(text) {
  return (text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function stripLeadingPunct(s) {
  return (s || "").replace(/^[\s:,\-–—]+/, "").trim();
}

function extractWakeCommand(rawText, wakeWords) {
  const t = normalize(rawText);
  if (!t) return null;

  let bestIdx = -1;
  let bestLen = 0;

  for (const wRaw of wakeWords) {
    const w = normalize(wRaw);
    if (!w) continue;

    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9])(${escaped})([^a-z0-9]|$)`, "i");
    const m = re.exec(t);

    if (m && typeof m.index === "number") {
      const idx = m.index + (m[1]?.length || 0);
      if (bestIdx === -1 || idx < bestIdx) {
        bestIdx = idx;
        bestLen = w.length;
      }
    } else {
      const idx = t.indexOf(w);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestLen = w.length;
      }
    }
  }

  if (bestIdx === -1) return null;

  const after = stripLeadingPunct(t.slice(bestIdx + bestLen));
  return { afterText: after };
}

function anyIncludes(s, arr) {
  return arr.some((p) => s.includes(p));
}

function looksLikeStop(raw) {
  const s = normalize(raw);
  return anyIncludes(s, [
    "stop",
    "pause",
    "cancel",
    "quiet",
    "shut up",
    "be quiet",
    "hold on",
    "hold",
    "end",
    "done",
    "mute",
    "stop reading",
    "pause reading",
    "cancel reading",
    "end reading",
    "stop reeding",
    "stop redding",
    "stop leading",
    "stop weeding",
  ]);
}

function looksLikeRead(raw) {
  const s = normalize(raw);
  return anyIncludes(s, [
    "read",
    "read that",
    "read this",
    "read it",
    "read document",
    "read the document",
    "read whole document",
    "start reading",
    "keep reading",
    "continue reading",
    "reading",
    "reeding",
    "reed",
    "red that",
    "weeding",
    "leading",
  ]);
}

function looksLikeHighlight(raw) {
  const s = normalize(raw);
  if (
    anyIncludes(s, [
      "highlight",
      "high light",
      "hilight",
      "hi light",
      "hilite",
      "highlite",
      "highlight that",
      "highlight this",
      "highlight it",
      "highlight sentence",
      "mark that",
      "underline that",
      "bracket that",
      "circle that",
      "star that",
      "tag that",
    ])
  ) {
    return true;
  }
  if (s.includes("highl") || s.startsWith("highl")) return true;
  return false;
}

function parseCommand(rawText) {
  const s = normalize(rawText);
  if (!s) return null;

  if (s.startsWith("note")) {
    const note = s.replace(/^note\b[:]?/i, "").trim();
    return { type: "note", note };
  }

  if (looksLikeStop(s)) return { type: "stop" };
  if (looksLikeRead(s)) return { type: "read" };
  if (looksLikeHighlight(s)) return { type: "highlight" };

  return { type: "unknown", text: rawText };
}

export default function VoiceBar({
  onFinalTranscript,
  onCommand,
  wakeWords = [
    "bertie",
    "berdie",
    "birdie",
    "burtie",
    "berty",
    "birty",
    "burty",
    "berdee",
    "beardy",
    "beattie",
    "betty",
    "barbie",
    "party",
    "pretty",
    "buddy",
    "dirty",
    "bernie",
    "verti",
    "verty",
    "thirdy",
    "thirty",
    "30",
  ],
  allowCommandWithoutWakeWord = true,
  defaultAlwaysOn = true,
}) {
  const SR = useMemo(() => getSpeechRecognition(), []);
  const [supported, setSupported] = useState(true);

  const [enabled, setEnabled] = useState(false);
  const [alwaysOn, setAlwaysOn] = useState(defaultAlwaysOn);
  const [wantMicOn, setWantMicOn] = useState(false);

  const [listening, setListening] = useState(false);
  const [live, setLive] = useState("");
  const [lastFinal, setLastFinal] = useState("");
  const [status, setStatus] = useState("Mic off");

  const [endCount, setEndCount] = useState(0);
  const [restartCount, setRestartCount] = useState(0);
  const [lastErr, setLastErr] = useState("");

  const recRef = useRef(null);
  const startingRef = useRef(false);

  // ✅ refs so handlers see latest values (without recreating recognition)
  const wantMicOnRef = useRef(wantMicOn);
  const alwaysOnRef = useRef(alwaysOn);
  const wakeWordsRef = useRef(wakeWords);
  const allowNoWakeRef = useRef(allowCommandWithoutWakeWord);
  const onFinalRef = useRef(onFinalTranscript);
  const onCmdRef = useRef(onCommand);

  useEffect(() => void (wantMicOnRef.current = wantMicOn), [wantMicOn]);
  useEffect(() => void (alwaysOnRef.current = alwaysOn), [alwaysOn]);
  useEffect(() => void (wakeWordsRef.current = wakeWords), [wakeWords]);
  useEffect(() => void (allowNoWakeRef.current = allowCommandWithoutWakeWord), [
    allowCommandWithoutWakeWord,
  ]);
  useEffect(() => void (onFinalRef.current = onFinalTranscript), [onFinalTranscript]);
  useEffect(() => void (onCmdRef.current = onCommand), [onCommand]);

  function safeStart(reason = "start") {
    const rec = recRef.current;
    if (!rec) return;
    if (startingRef.current) return;
    if (!wantMicOnRef.current) return;

    startingRef.current = true;
    setStatus(`Listening… (${reason})`);

    setTimeout(() => {
      try {
        rec.start();
        setRestartCount((c) => c + 1);
      } catch {
        setTimeout(() => {
          try {
            rec.start();
            setRestartCount((c) => c + 1);
          } catch {}
        }, 250);
      } finally {
        startingRef.current = false;
      }
    }, 150);
  }

  useEffect(() => {
    if (!SR) {
      setSupported(false);
      return;
    }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => {
      setListening(true);
      setStatus("Listening…");
      setLastErr("");
    };

    rec.onresult = (event) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += text;
        else interim += text;
      }

      const merged = (finalText || interim).trim();
      setLive(merged);

      if (!finalText.trim()) return;

      const cleanFinal = finalText.trim();
      setLastFinal(cleanFinal);
      onFinalRef.current?.(cleanFinal);

      const found = extractWakeCommand(cleanFinal, wakeWordsRef.current);
      if (found && found.afterText) {
        onCmdRef.current?.(parseCommand(found.afterText));
        return;
      }

      if (allowNoWakeRef.current) {
        const cmd = parseCommand(cleanFinal);
        if (cmd && cmd.type !== "unknown") onCmdRef.current?.(cmd);
      }
    };

    rec.onerror = (e) => {
      const err = e?.error || "unknown";
      setLastErr(err);
      setStatus(`Mic error: ${err}`);
      setListening(false);

      if (err === "not-allowed" || err === "service-not-allowed") {
        setEnabled(false);
        setWantMicOn(false);
        setStatus("Mic blocked (permission denied)");
        return;
      }

      if (wantMicOnRef.current && alwaysOnRef.current) safeStart(`error:${err}`);
    };

    rec.onend = () => {
      setListening(false);
      setEndCount((c) => c + 1);
      if (wantMicOnRef.current && alwaysOnRef.current) safeStart("onend");
      else setStatus("Mic off");
    };

    recRef.current = rec;

    return () => {
      try {
        rec.onstart = null;
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.stop();
      } catch {}
      recRef.current = null;
    };
  }, [SR]);

  function enableAndStart() {
    if (!recRef.current) return;
    setEnabled(true);
    setWantMicOn(true);
    setStatus("Starting…");
    setLive("");
    safeStart("enable");
  }

  function stopAll() {
    const rec = recRef.current;
    if (!rec) return;
    setWantMicOn(false);
    setStatus("Mic off");
    setLive("");
    try {
      rec.stop();
    } catch {}
    setListening(false);
  }

  return (
    <div style={{ marginTop: 12, padding: 12, border: "1px solid #ddd", borderRadius: 10 }}>
      <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
        <div>Mic</div>
        <div style={{ fontSize: 12, color: "#666" }}>{status}</div>
      </div>

      {!supported ? (
        <div style={{ color: "#666", marginTop: 6 }}>
          SpeechRecognition not supported here. Use Chrome/Edge.
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>{live ? `“${live}”` : `Try: “bertie read document”`}</div>
      )}

      {lastFinal ? (
        <div style={{ marginTop: 6, fontSize: 13, color: "#666" }}>Last: “{lastFinal}”</div>
      ) : null}

      {supported ? (
        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!enabled ? (
            <button onClick={enableAndStart}>🎤 Enable Mic</button>
          ) : listening ? (
            <button onClick={stopAll}>Stop Mic</button>
          ) : (
            <button onClick={enableAndStart}>Start Listening</button>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={alwaysOn} onChange={() => setAlwaysOn((v) => !v)} />
            Always listening
          </label>
        </div>
      ) : null}

      <div style={{ marginTop: 10, fontSize: 12, color: "#666", lineHeight: 1.4 }}>
        Debug: ends={endCount}, restarts={restartCount}
        {lastErr ? `, lastErr=${lastErr}` : ""}
      </div>
    </div>
  );
}
import React from "react";

export default function Sidebar({
  pdfName,
  transcript,
  statusMsg,
  highlight,
  onChangeNote,
  onDelete,
}) {
  return (
    <div style={{ marginTop: 12, padding: 12, border: "1px solid #ddd", borderRadius: 10 }}>
      <div style={{ fontWeight: 700 }}>Status</div>
      <div style={{ marginTop: 6 }}>PDF: {pdfName || "—"}</div>
      <div>Message: {statusMsg || "—"}</div>
      <div style={{ marginTop: 10, color: "#666" }}>Last transcript: {transcript || "—"}</div>

      <hr style={{ margin: "12px 0" }} />

      <div style={{ fontWeight: 700 }}>Selected highlight</div>
      {!highlight ? (
        <div style={{ color: "#666", marginTop: 6 }}>Click a highlight to edit its note.</div>
      ) : (
        <>
          <div style={{ marginTop: 8, fontSize: 14 }}>
            <div style={{ color: "#666" }}>Text</div>
            <div>{highlight.content?.text || "(no text)"}</div>
          </div>

          <div style={{ marginTop: 10 }}>
            <div style={{ color: "#666" }}>Note</div>
            <textarea
              style={{ width: "100%", minHeight: 80, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
              value={highlight.note || ""}
              onChange={(e) => onChangeNote(e.target.value)}
              placeholder='Try: "note: this is important"'
            />
          </div>

          <button style={{ marginTop: 10 }} onClick={onDelete}>
            Delete highlight
          </button>
        </>
      )}
    </div>
  );
}



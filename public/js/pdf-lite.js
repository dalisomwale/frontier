// A small PDF writer for the browser: A4 pages with text (Helvetica,
// Helvetica Bold, Courier), lines and filled boxes. Enough for a receipt.
//   const pdf = createPdf();
//   pdf.text(56, 80, "Hello", { size: 12, font: "bold", color: "#166534", align: "left" | "right" });
//   pdf.line(56, 90, 539, 90, { color: "#e5e7eb", width: 1, dash: [3, 3] });
//   pdf.save("file.pdf");
// Positions are in points from the top-left corner (A4 is 595 x 842).
(function () {
  const W = 595.28;
  const H = 841.89;

  // Character widths (per 1000) for codes 32..126.
  const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  const FONTS = { regular: { key: "F1", widths: HELV }, bold: { key: "F2", widths: BOLD }, mono: { key: "F3", widths: null } };

  // Characters outside Latin-1 that WinAnsi has.
  const WIN = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };
  function toWin(str) {
    let out = "";
    for (const ch of String(str ?? "")) {
      const code = ch.codePointAt(0);
      if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
      else if (code === 0x2009 || code === 0x202f || code === 0xa0) out += " ";
      else if (code < 256) out += ch;
      else out += "?";
    }
    return out;
  }

  function charWidth(code, font) {
    if (!font.widths) return 600;
    if (code >= 32 && code <= 126) return font.widths[code - 32];
    if (code === 0xb7 || code === 0x95) return font === FONTS.bold ? 278 : 278;
    return 556;
  }

  function measure(str, size = 11, fontName = "regular") {
    const font = FONTS[fontName] || FONTS.regular;
    const s = toWin(str);
    let w = 0;
    for (let i = 0; i < s.length; i++) w += charWidth(s.charCodeAt(i), font);
    return (w * size) / 1000;
  }

  // Shorten text with "…" so it fits the width.
  function fit(str, maxWidth, size = 11, fontName = "regular") {
    let s = String(str ?? "");
    if (measure(s, size, fontName) <= maxWidth) return s;
    while (s.length > 1 && measure(s + "…", size, fontName) > maxWidth) s = s.slice(0, -1);
    return s.trimEnd() + "…";
  }

  const rgb = (hex) => {
    const h = String(hex || "#000000").replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" ");
  };
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r?\n/g, " ");
  const num = (v) => (Math.round(v * 100) / 100).toString();

  window.createPdf = function () {
    const pages = [[]];
    let page = pages[0];
    const api = {
      width: W,
      height: H,
      measure,
      fit,
      addPage() { page = []; pages.push(page); return api; },
      text(x, y, str, { size = 11, font = "regular", color = "#111827", align = "left" } = {}) {
        const f = FONTS[font] || FONTS.regular;
        const w = measure(str, size, font);
        const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
        page.push(`BT /${f.key} ${num(size)} Tf ${rgb(color)} rg ${num(left)} ${num(H - y)} Td (${esc(toWin(str))}) Tj ET`);
        return api;
      },
      line(x1, y1, x2, y2, { color = "#e5e7eb", width = 1, dash = null } = {}) {
        page.push(`q ${rgb(color)} RG ${num(width)} w ${dash ? `[${dash.join(" ")}] 0 d` : "[] 0 d"} ${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S Q`);
        return api;
      },
      rect(x, y, w, h, { fill = "#f3f4f6" } = {}) {
        page.push(`q ${rgb(fill)} rg ${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re f Q`);
        return api;
      },
      blob() {
        const objs = [];
        const add = (body) => { objs.push(body); return objs.length; };
        const catalog = add(null);
        const pagesId = add(null);
        const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
        const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
        const f3 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
        const kids = pages.map((ops) => {
          const stream = ops.join("\n");
          const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
          return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${content} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> >>`);
        });
        objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
        objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
        let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
        const offsets = [];
        objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
        const xref = out.length;
        out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
        out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
        // Every character is one byte (WinAnsi), so copy the codes straight across.
        const bytes = new Uint8Array(out.length);
        for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
        return new Blob([bytes], { type: "application/pdf" });
      },
      save(filename) {
        const url = URL.createObjectURL(api.blob());
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      },
    };
    return api;
  };
})();

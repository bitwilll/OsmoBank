/* Minimal, dependency-free PDF writer.
 * Enough to render a banking statement / report: a title, meta lines, section
 * headings, key/value rows, and simple tables — using the PDF built-in
 * Helvetica fonts (no font embedding needed). Multi-page with auto page breaks.
 */

const PAGE_W = 612;   // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const LINE = 15;

// Escape text for a PDF string literal.
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  // strip anything outside printable Latin-1 to keep the single-byte encoding valid
  .replace(/[^\x20-\x7e\xa0-\xff]/g, '');

export class Pdf {
  constructor({ title = 'OsmoBank' } = {}) {
    this.title = title;
    this.pages = [];       // each page = array of content-stream ops
    this._newPage();
  }

  _newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE_H - MARGIN;
  }

  _room(n = LINE) {
    if (this.y - n < MARGIN) this._newPage();
  }

  text(str, { size = 10, font = 'F1', x = MARGIN, gray = 0 } = {}) {
    this._room();
    this.ops.push(`BT /${font} ${size} Tf ${gray} g ${x} ${this.y} Td (${esc(str)}) Tj ET`);
    this.y -= LINE;
    return this;
  }

  /** Left label + right-aligned value on one row. */
  row(label, value, { size = 10, labelGray = 0.35, valueGray = 0 } = {}) {
    this._room();
    const rightX = PAGE_W - MARGIN - this._width(value, size, true);
    this.ops.push(`BT /F1 ${size} Tf ${labelGray} g ${MARGIN} ${this.y} Td (${esc(label)}) Tj ET`);
    this.ops.push(`BT /F2 ${size} Tf ${valueGray} g ${rightX} ${this.y} Td (${esc(value)}) Tj ET`);
    this.y -= LINE;
    return this;
  }

  heading(str) {
    this.gap(6);
    this.text(str, { size: 12, font: 'F2', gray: 0 });
    this.rule();
    return this;
  }

  /** A table: columns = [{label, width, align}], rows = [[c,c,...]]. widths are fractions. */
  table(columns, rows, { size = 9 } = {}) {
    const usable = PAGE_W - 2 * MARGIN;
    const xs = [];
    let acc = MARGIN;
    for (const c of columns) { xs.push(acc); acc += c.width * usable; }
    const drawRow = (cells, { header = false } = {}) => {
      this._room();
      cells.forEach((cell, i) => {
        const col = columns[i];
        const s = String(cell);
        let x = xs[i];
        if (col.align === 'right') x = xs[i] + col.width * usable - this._width(s, size, header) - 4;
        this.ops.push(`BT /${header ? 'F2' : 'F1'} ${size} Tf ${header ? 0.35 : 0} g ${x} ${this.y} Td (${esc(s)}) Tj ET`);
      });
      this.y -= LINE;
    };
    drawRow(columns.map((c) => c.label), { header: true });
    this.rule();
    for (const r of rows) drawRow(r);
    return this;
  }

  rule() {
    this._room(8);
    this.y += 4;
    this.ops.push(`0.8 G ${MARGIN} ${this.y} m ${PAGE_W - MARGIN} ${this.y} l S`);
    this.y -= 8;
    return this;
  }

  gap(n = LINE) { this.y -= n; return this; }

  // Rough Helvetica width (avg 0.5em) — good enough for right-alignment.
  _width(str, size, bold = false) { return String(str).length * size * (bold ? 0.55 : 0.5); }

  build() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; }; // returns 1-based obj number

    // Fonts
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

    // Header band + footer on every page
    const pageObjNums = [];
    const contentObjNums = [];
    for (let i = 0; i < this.pages.length; i++) {
      const header =
        `BT /F2 16 0 g ${MARGIN} ${PAGE_H - 34} Td (${esc(this.title)}) Tj ET ` +
        `BT /F1 8 0.5 g ${PAGE_W - MARGIN - 120} ${PAGE_H - 34} Td (Page ${i + 1} of ${this.pages.length}) Tj ET ` +
        `0.8 G ${MARGIN} ${PAGE_H - 44} m ${PAGE_W - MARGIN} ${PAGE_H - 44} l S`;
      const stream = header + '\n' + this.pages[i].join('\n');
      const contentNum = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
      contentObjNums.push(contentNum);
      pageObjNums.push(null); // placeholder, filled below
    }

    // Pages tree needs the pages parent obj number known first — reserve it.
    const pagesNum = objs.length + this.pages.length + 1; // pages after the per-page objs
    for (let i = 0; i < this.pages.length; i++) {
      const num = add(
        `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> ` +
        `/Contents ${contentObjNums[i]} 0 R >>`);
      pageObjNums[i] = num;
    }
    const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
    add(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`); // == pagesNum
    const catalogNum = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

    // Assemble file with xref
    let pdf = '%PDF-1.4\n%\xff\xff\xff\xff\n';
    const offsets = [];
    for (let i = 0; i < objs.length; i++) {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xrefStart = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }
}

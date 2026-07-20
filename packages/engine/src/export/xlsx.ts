/**
 * A minimal .xlsx writer with zero dependencies.
 *
 * An xlsx file is a ZIP of XML parts. This writes the smallest valid set —
 * content types, relationships, workbook, one worksheet with inline strings —
 * into a ZIP using STORE (no compression). Excel, Numbers, and Google Sheets
 * all open it; the files are larger than a compressed xlsx, but a lead list is
 * a few megabytes at most and this keeps the whole app dependency-free.
 *
 * Values: numbers become numeric cells (so spreadsheets can sort and sum);
 * everything else becomes an inline string. No formulas are ever emitted, so
 * the CSV formula-injection concern does not apply here.
 */

import { crc32 } from 'node:zlib';

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;')
   // Control characters are invalid in XML 1.0 and abort the whole sheet.
   .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '<c/>';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c><v>${value}</v></c>`;
  return `<c t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`;
}

/** Build a single-sheet workbook from rows, with `columns` as the header order. */
export function toXlsx(rows: Record<string, unknown>[], columns: string[], sheetName = 'Leads'): Buffer {
  const allRows = [columns as unknown[], ...rows.map((r) => columns.map((c) => r[c]))];
  const sheetData = allRows
    .map((cells, i) => `<row r="${i + 1}">${cells.map(cell).join('')}</row>`)
    .join('');

  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${sheetData}</sheetData></worksheet>`,
  };

  return zipStore(files);
}

/** Assemble a ZIP with STORE entries (no compression) — ~90 lines beats a dependency. */
function zipStore(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0, 6);          // flags
    local.writeUInt16LE(0, 8);          // method: STORE
    local.writeUInt32LE(0, 10);         // dos time+date (unset)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // extra length
    chunks.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // central directory signature
    entry.writeUInt16LE(20, 4);         // version made by
    entry.writeUInt16LE(20, 6);         // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);         // method: STORE
    entry.writeUInt32LE(0, 12);         // dos time+date
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    // comment/disk/attr fields stay zero
    entry.writeUInt32LE(offset, 42);    // local header offset
    central.push(Buffer.concat([entry, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);  // entries on this disk
  eocd.writeUInt16LE(central.length, 10); // entries total
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

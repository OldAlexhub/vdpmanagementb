// PDF reports: the provider VDP statement, the cycle payment register and the cycle schedule.
// Built with pdfkit's standard Helvetica (WinAnsi), so text is sanitised to that character set.
import PDFDocument from 'pdfkit';
import { loadRegister } from './exportService.js';
import { isoDate, localDate } from './cycleService.js';
import { D, fmtMoney, fmtNum, fmtRate, sum, money } from './money.js';
import { ISSUE_AREAS } from '../models/Vdp.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import VdpPlan from '../models/VdpPlan.js';
import Provider from '../models/Provider.js';
import { currentVersion, fuelMethodOf, uberConfigOf } from './planService.js';
import { notFound } from './errors.js';

// Register "Other" column: other deductions plus any fuel overspend (both are deductions).
const otherOf = (c) => money(sum([c?.otherDeductions ?? 0, c?.fuelOverspend ?? 0]));

const C = {
  navy: '#0f2a4a',
  navy2: '#1b4270',
  ink: '#0f172a',
  text: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',
  line: '#e2e8f0',
  soft: '#f6f8fb',
  gold: '#f5b301',
  goldSoft: '#fff7e0',
  green: '#117a45',
  greenSoft: '#e7f5ec',
  red: '#b42318',
  redSoft: '#fdecea',
  amber: '#a15c00',
  amberSoft: '#fff4e0',
  blue: '#1d5fd1',
  blueSoft: '#eaf1fd',
};
const F = { reg: 'Helvetica', bold: 'Helvetica-Bold', ital: 'Helvetica-Oblique' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Characters outside WinAnsi would print as garbage.
const t = (s) => String(s ?? '')
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u2192\u21d2]/g, '>')
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/−/g, '–')
  .replace(/[→⇒]/g, '>')
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, "'");

const longDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const shortDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
const md = (v) => shortDate(v).slice(0, 5);
const cycleText = (c) => (c ? `${shortDate(c.cycleStart)} – ${shortDate(c.cycleEnd)}` : '—');
const mny = (v) => (v === null || v === undefined || v === '' ? '—' : fmtMoney(v));
const hrs = (v) => (v === null || v === undefined ? '—' : `${fmtNum(v)} h`);
const pctText = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(3).replace(/\.?0+$/, '')}%`);
const rateOrOps = (v) => (v === null || v === undefined ? 'Per operator' : fmtRate(v));

// ---------- primitives ----------

function newDoc(layout = 'portrait', meta = {}) {
  const doc = new PDFDocument({
    size: 'LETTER', layout, bufferPages: true,
    margins: { top: 44, bottom: 56, left: 44, right: 44 },
    info: { Author: 'Big Star Transit', Creator: 'Big Star VDP', ...meta },
  });
  doc.content = { left: 44, right: doc.page.width - 44, width: doc.page.width - 88 };
  return doc;
}

function star(doc, cx, cy, r, color) {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  doc.polygon(...pts).fill(color);
}

function headerBand(doc, { title, rightLabel, rightTitle, rightSub }) {
  const w = doc.page.width;
  doc.save();
  doc.rect(0, 0, w, 92).fill(C.navy);
  doc.rect(0, 92, w, 3).fill(C.gold);
  // mark
  doc.roundedRect(44, 26, 36, 36, 8).fill(C.gold);
  star(doc, 62, 44.5, 13, C.navy);
  doc.fillColor('#ffffff').font(F.bold).fontSize(15).text('BIG STAR TRANSIT', 92, 29, { characterSpacing: 1.2, lineBreak: false });
  doc.fillColor('#b9c9dc').font(F.reg).fontSize(9.5).text(t(title), 92, 50, { lineBreak: false });
  // right block
  const rw = 260;
  const rx = w - 44 - rw;
  doc.fillColor(C.gold).font(F.bold).fontSize(7).text(t(rightLabel).toUpperCase(), rx, 26, { width: rw, align: 'right', characterSpacing: 1.4 });
  doc.fillColor('#ffffff').font(F.bold).fontSize(13).text(t(rightTitle), rx, 37, { width: rw, align: 'right' });
  if (rightSub) doc.fillColor('#b9c9dc').font(F.reg).fontSize(8.5).text(t(rightSub), rx, 56, { width: rw, align: 'right' });
  doc.restore();
  doc.y = 116;
}

function ensure(doc, height) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    doc.y = doc.page.margins.top;
    return true;
  }
  return false;
}

function sectionTitle(doc, text, hint) {
  ensure(doc, 60);
  doc.moveDown(0.4);
  const y = doc.y;
  doc.fillColor(C.navy).font(F.bold).fontSize(10.5).text(t(text).toUpperCase(), doc.content.left, y, { characterSpacing: 0.9 });
  doc.rect(doc.content.left, doc.y + 3, 26, 2).fill(C.gold);
  if (hint) {
    doc.fillColor(C.muted).font(F.reg).fontSize(8).text(t(hint), doc.content.left, y + 1.5, { width: doc.content.width, align: 'right' });
  }
  doc.y = y + 22;
}

function chip(doc, text, x, y, tone) {
  const tones = {
    ok: [C.greenSoft, C.green], warn: [C.amberSoft, C.amber], bad: [C.redSoft, C.red],
    info: [C.blueSoft, C.blue], draft: ['#eef2f6', C.text],
  };
  const [bg, fg] = tones[tone] || tones.draft;
  doc.font(F.bold).fontSize(8);
  const w = doc.widthOfString(t(text)) + 20;
  doc.roundedRect(x - w, y, w, 18, 9).fill(bg);
  doc.circle(x - w + 9, y + 9, 2.4).fill(fg);
  doc.fillColor(fg).text(t(text), x - w + 14, y + 5.2, { lineBreak: false });
  return w;
}

/**
 * Ruled table with header row, page breaks and optional row styles.
 * columns: [{ header, width, align }]; rows: [{ cells: [], style: 'normal'|'strong'|'total'|'muted', sub: [] }]
 */
function table(doc, columns, rows, { fontSize = 9, rowPad = 6, headerFill = C.soft, x0 = doc.content.left, totalBump = 1 } = {}) {
  const totalW = columns.reduce((a, c) => a + c.width, 0);
  const drawHeader = () => {
    const y = doc.y;
    doc.rect(x0, y, totalW, 20).fill(headerFill);
    let x = x0;
    doc.fillColor(C.muted).font(F.bold).fontSize(7.2);
    columns.forEach((c) => {
      doc.text(t(c.header).toUpperCase(), x + 7, y + 7, { width: c.width - 14, height: 9, align: c.align || 'left', characterSpacing: 0.4, lineBreak: false, ellipsis: true });
      x += c.width;
    });
    doc.y = y + 20;
  };
  drawHeader();
  rows.forEach((row) => {
    const hasSub = row.sub && row.sub.some(Boolean);
    const h = fontSize + rowPad * 2 + (hasSub ? fontSize : 0);
    if (ensure(doc, h + 4)) drawHeader();
    const y = doc.y;
    if (row.style === 'total') {
      doc.rect(x0, y, totalW, h).fill(C.soft);
      doc.moveTo(x0, y).lineTo(x0 + totalW, y).lineWidth(1).strokeColor(C.navy).stroke();
    } else if (row.fill) {
      doc.rect(x0, y, totalW, h).fill(row.fill);
    }
    let x = x0;
    const size = row.style === 'total' ? fontSize + totalBump : fontSize;
    columns.forEach((c, i) => {
      const bold = row.style === 'strong' || row.style === 'total' || (i === 0 && row.style !== 'muted' && row.labelBold !== false) || row.boldCols?.includes(i);
      const color = row.colors?.[i] || (row.style === 'muted' ? C.muted : C.ink);
      doc.fillColor(row.style === 'total' ? C.navy : color).font(bold ? F.bold : F.reg).fontSize(size)
        .text(t(row.cells[i]), x + 7, y + rowPad - (size - fontSize) / 2, { width: c.width - 14, height: size + 2, align: c.align || 'left', lineBreak: false, ellipsis: true });
      if (hasSub && row.sub[i]) {
        doc.fillColor(C.muted).font(F.reg).fontSize(fontSize - 1.8)
          .text(t(row.sub[i]), x + 7, y + rowPad + fontSize + 1.5, { width: c.width - 14, height: fontSize, align: c.align || 'left', lineBreak: false, ellipsis: true });
      }
      x += c.width;
    });
    doc.y = y + h;
    if (row.style !== 'total') {
      doc.moveTo(x0, doc.y).lineTo(x0 + totalW, doc.y).lineWidth(0.6).strokeColor(C.line).stroke();
    }
  });
  doc.y += 6;
}

function footers(doc, leftText) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // footer lives in the margin; don't let pdfkit add a page
    const y = doc.page.height - 36;
    const { left, right } = { left: 44, right: doc.page.width - 44 };
    doc.moveTo(left, y - 8).lineTo(right, y - 8).lineWidth(0.6).strokeColor(C.line).stroke();
    doc.fillColor(C.faint).font(F.reg).fontSize(7.5);
    doc.text(t(leftText), left, y, { width: right - left - 80, lineBreak: false, ellipsis: true });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, right - 80, y, { width: 80, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

function watermark(doc, text) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save();
    doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.fillColor('#b42318').opacity(0.07).font(F.bold).fontSize(64)
      .text(text, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false });
    doc.restore();
    doc.page.margins.bottom = savedBottom;
  }
}

const toBuffer = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
  doc.end();
});

// ---------- statement ----------

function statusLine(m, stamp) {
  const a = m.providerApproval;
  const sub = m.view?.cycle?.submissionDate;
  if (m.view?.source !== 'SNAPSHOT') return ['Draft — not approved', 'draft'];
  switch (m.status) {
    case 'APPROVED': return [`Awaiting provider approval · due by end of ${longDate(sub)}`, 'warn'];
    case 'DISPUTED': return ['Issue reported · under review by Big Star', 'bad'];
    case 'IN_CORRECTION': return ['Being corrected by Big Star', 'warn'];
    case 'PROCESSED': return [a?.method === 'AUTO' ? `Auto-approved ${stamp(a.at)}` : `Approved by provider ${stamp(a?.at)}`, 'ok'];
    case 'PAID': return [`Paid ${stamp(m.paidAt)}`, 'info'];
    default: return [m.status, 'draft'];
  }
}

function infoGrid(doc, items, x, y, width, cols = 3) {
  const colW = width / cols;
  items.forEach(([k, v], i) => {
    const cx = x + (i % cols) * colW;
    const cy = y + Math.floor(i / cols) * 34;
    doc.fillColor(C.muted).font(F.reg).fontSize(7.5).text(t(k).toUpperCase(), cx, cy, { width: colW - 10, characterSpacing: 0.4, lineBreak: false });
    doc.fillColor(C.ink).font(F.bold).fontSize(9.5).text(t(v), cx, cy + 11, { width: colW - 10, lineBreak: false, ellipsis: true });
  });
  return y + Math.ceil(items.length / cols) * 34;
}

function netBox(doc, calc, x, y, w, h) {
  doc.roundedRect(x, y, w, h, 8).fill(C.navy);
  doc.roundedRect(x + 16, y + h - 14, 36, 3, 1.5).fill(C.gold);
  doc.fillColor(C.gold).font(F.bold).fontSize(7.5).text('NET VDP PAYMENT', x + 16, y + 14, { characterSpacing: 1.3 });
  doc.fillColor('#ffffff').font(F.bold).fontSize(26).text(t(calc ? fmtMoney(calc.net) : '—'), x + 16, y + 28, { width: w - 32 });
  if (calc) {
    doc.fillColor('#b9c9dc').font(F.reg).fontSize(8)
      .text(t(`Gross ${fmtMoney(calc.gross)}  ·  Deductions ${fmtMoney(calc.totalDeductions)}${calc.totalAdditions !== '0.00' ? `  ·  Additions ${fmtMoney(calc.totalAdditions)}` : ''}`), x + 16, y + 64, { width: w - 32 });
  }
}

const TONE_COLOR = { minus: C.red, plus: C.green, total: C.navy, subtotal: C.ink };

function stepsTable(doc, steps, x0, width) {
  table(doc, [
    { header: 'Item', width: width * 0.3 },
    { header: 'How', width: width * 0.47 },
    { header: 'Amount', width: width * 0.23, align: 'right' },
  ], steps.map((s) => ({
    cells: [s.label, s.detail, s.value],
    style: s.tone === 'total' ? 'total' : s.tone === 'subtotal' ? 'strong' : undefined,
    colors: [s.tone === 'total' ? C.navy : C.ink, C.muted, TONE_COLOR[s.tone] || C.ink],
    boldCols: s.tone === 'money' || s.tone === 'minus' || s.tone === 'plus' ? [2] : [],
    labelBold: s.tone !== 'info',
  })), { x0, fontSize: 8.6, rowPad: 5.5 });
}

const ratio = (value, digits = 2) => (value === null || value === undefined
  ? '-'
  : `${(Number(value) * 100).toFixed(digits).replace(/\.?0+$/, '')}%`);

function uberStatementSections(doc, v, calc, left, width) {
  const rows = calc.uberRows || [];
  const first = rows[0];

  if (first) {
    sectionTitle(doc, 'Uber plan configuration', 'The same calculation engine applies the plan rules frozen with this VDP');
    table(doc, [
      { header: 'Rate structure', width: width * 0.22 },
      { header: 'Min. fulfillment', width: width * 0.2 },
      { header: 'Below threshold', width: width * 0.2 },
      { header: 'Utilization', width: width * 0.18 },
      { header: 'Core-hours rule', width: width * 0.2 },
    ], [{ cells: [
      first.rateStructureType === 'HOURLY_BANDS' ? 'Hourly bands' : 'Flat hourly rate',
      ratio(first.qualificationThreshold),
      first.belowThresholdBehavior === 'CORE_ONLY' ? 'Core only' : 'Fares only',
      first.utilizationEnabled === false ? 'Disabled' : 'Enabled',
      first.coreHoursRuleType === 'CONTINUOUS_COVERAGE' ? 'Continuous coverage - validate' : first.coreHoursRuleType === 'NONE' ? 'None' : 'Percentage',
    ] }], { fontSize: 8, rowPad: 4 });

    const bandRows = rows.flatMap((row) => row.rateStructureType === 'HOURLY_BANDS'
      ? (row.baseCompensationBreakdown || []).map((band) => ({ row, band }))
      : []);
    if (bandRows.length) {
      ensure(doc, 70);
      sectionTitle(doc, 'Hourly-band compensation', 'Payable hours priced by the configured plan bands');
      table(doc, [
        { header: 'Week / pay unit', width: width * 0.34 },
        { header: 'Band', width: width * 0.2 },
        { header: 'Hours', width: width * 0.14, align: 'right' },
        { header: 'Rate', width: width * 0.14, align: 'right' },
        { header: 'Amount', width: width * 0.18, align: 'right' },
      ], bandRows.map(({ row, band }) => ({
        cells: [`${md(row.week)} - ${row.calculationUnitLabel}`, `${fmtNum(band.fromHour)}-${fmtNum(band.toHour)} h`, fmtNum(band.hours), fmtMoney(band.hourlyRate), fmtMoney(band.amount)],
        boldCols: [4],
      })), { fontSize: 7.8, rowPad: 3.5 });
    }
  }

  sectionTitle(doc, 'Cycle earnings summary', 'Weekly vehicle/pay-unit results with toll credits and provider bills shown separately');
  table(doc, [
    { header: 'Week', width: width * 0.22 },
    { header: 'Pay units', width: width * 0.14, align: 'right' },
    { header: 'Drivers', width: width * 0.14, align: 'right' },
    { header: 'Calculated pay', width: width * 0.18, align: 'right' },
    { header: 'Toll + / bill -', width: width * 0.15, align: 'right' },
    { header: 'Week Gross', width: width * 0.17, align: 'right' },
  ], (calc.weeks || []).map((week) => ({
    cells: [
      shortDate(week.week), week.calculationUnitCount, week.driverCount, fmtMoney(week.calculatedEarnings),
      `+${fmtMoney(week.adjustmentTolls)} / -${fmtMoney(week.adjustmentTollDeductions)}`,
      fmtMoney(week.weeklyEarnings),
    ],
    boldCols: [5],
    colors: [C.ink, C.text, C.text, C.text, Number(week.adjustmentTolls) || Number(week.adjustmentTollDeductions) ? C.ink : C.muted, C.navy],
  })), { fontSize: 8.4, rowPad: 5 });

  ensure(doc, 90);
  sectionTitle(doc, 'Weekly contract evaluation', 'Hours are qualifying / contracted / payable. Rates show measured result and earned tier.');
  table(doc, [
    { header: 'Week', width: 46 },
    { header: 'Unit', width: 66 },
    { header: 'Drivers', width: 92 },
    { header: 'Q / C / P', width: 72, align: 'right' },
    { header: 'Fulfill.', width: 56, align: 'right' },
    { header: 'A / C rates', width: 68, align: 'right' },
    { header: 'Util / core', width: 72, align: 'right' },
    { header: 'Pay', width: width - 472, align: 'right' },
  ], rows.map((row) => ({
    cells: [
      md(row.week),
      row.vehicleUnit ? `Vehicle ${row.vehicleUnit}` : row.calculationUnitLabel,
      (row.operatorNames || [row.operatorName]).filter(Boolean).join(', '),
      `${fmtNum(row.qualifyingSupplyHours)} / ${fmtNum(row.contractedHours)} / ${fmtNum(row.payableHours)}`,
      ratio(row.fulfillment),
      `${ratio(row.acceptanceRate)} / ${ratio(row.cancellationRate)}`,
      `${row.utilizationEnabled === false ? 'disabled' : ratio(row.utilizationRate)} / ${row.coreHoursRuleType === 'PERCENTAGE' ? ratio(row.coreHoursPct) : row.coreHoursRuleType === 'CONTINUOUS_COVERAGE' ? 'validate' : 'n/a'}`,
      fmtMoney(row.grossVdp),
    ],
    sub: [
      '', '', row.vehicleUnit && (row.operatorNames || []).length > 1 ? 'Shared vehicle' : '', '',
      row.qualified ? `Tier ${ratio(row.hourIncentivePct)}` : `${row.belowThresholdBehavior === 'CORE_ONLY' ? 'Core-only' : 'Fares-only'} rule`,
      `Earned ${ratio(row.acceptanceCancellationPct)}`,
      `${row.utilizationEnabled === false ? 'Off' : ratio(row.utilizationIncentivePct)} / ${row.coreHoursValidationStatus === 'REQUIRES_COVERAGE_VALIDATION' ? 'validate' : row.coreHoursValidationStatus === 'NOT_APPLICABLE' ? 'n/a' : row.coreHoursPassed ? 'pass' : 'below'}`,
      '',
    ],
    fill: row.qualified ? C.greenSoft : C.amberSoft,
    boldCols: [4, 7],
  })), { fontSize: 7.5, rowPad: 4 });

  ensure(doc, 90);
  sectionTitle(doc, 'Earnings components', 'Driver earnings excluding tips are shown for fallback audit and are not added to qualified pay');
  table(doc, [
    { header: 'Week / pay unit', width: 122 },
    { header: 'Core', width: 64, align: 'right' },
    { header: 'Hours inc.', width: 72, align: 'right' },
    { header: 'A/C inc.', width: 74, align: 'right' },
    { header: 'Util inc.', width: 66, align: 'right' },
    { header: 'Tips', width: 52, align: 'right' },
    { header: 'Calc. pay', width: width - 450, align: 'right' },
  ], rows.map((row) => ({
    cells: [
      `${md(row.week)} - ${row.vehicleUnit ? `vehicle ${row.vehicleUnit}` : row.calculationUnitLabel}`,
      fmtMoney(row.coreCompensation), fmtMoney(row.contractHoursIncentive), fmtMoney(row.acceptanceCancellationIncentive),
      fmtMoney(row.utilizationIncentive), fmtMoney(row.tips), fmtMoney(row.grossVdp),
    ],
    sub: [`${row.belowThresholdBehavior === 'CORE_ONLY' ? 'Core fallback' : 'Fares fallback'} ${row.belowThresholdBehavior === 'CORE_ONLY' ? fmtMoney(row.coreCompensation) : fmtMoney(row.driverEarningsExclTips)}`, '', ratio(row.hourIncentivePct), ratio(row.acceptanceCancellationPct), row.utilizationEnabled === false ? 'Disabled' : ratio(row.utilizationIncentivePct), '', ''],
    boldCols: [6],
  })), { fontSize: 7.8, rowPad: 4 });

  const sourceRows = rows.flatMap((row) => (row.raw?.sourceRows || []).map((source) => ({ ...source, vehicleUnit: row.vehicleUnit })));
  if (sourceRows.length) {
    ensure(doc, 90);
    sectionTitle(doc, 'Driver source detail', 'Matched provider operators; Uber UUIDs are retained internally for audit, not used as provider joins');
    table(doc, [
      { header: 'Week', width: 44 },
      { header: 'Driver', width: 96 },
      { header: 'Ctr h', width: 52, align: 'right' },
      { header: 'Supply', width: 50, align: 'right' },
      { header: 'Paused', width: 48, align: 'right' },
      { header: 'Qual.', width: 48, align: 'right' },
      { header: 'A/R/E/C', width: 70, align: 'right' },
      { header: 'Earn. excl.', width: 76, align: 'right' },
      { header: 'Tips', width: width - 484, align: 'right' },
    ], sourceRows.map((source) => ({
      cells: [
        md(source.week), source.operatorName || 'Operator', fmtNum(source.contractedHours), fmtNum(source.totalSupplyHours), fmtNum(source.pausedHours),
        fmtNum(D(source.totalSupplyHours).minus(source.pausedHours)),
        `${fmtNum(source.totalAccepts)} / ${fmtNum(source.totalRejects)} / ${fmtNum(source.totalExpiredOffers)} / ${fmtNum(source.totalCancels)}`,
        fmtMoney(source.driverEarningsExclTips), fmtMoney(source.driverTips),
      ],
      labelBold: false,
    })), { fontSize: 7.4, rowPad: 3.5 });
  }

  const leases = v.lease?.operators || [];
  if (leases.length) {
    ensure(doc, 80);
    sectionTitle(doc, 'Vehicle lease', 'One charge per distinct vehicle/pay unit, even when operators share it');
    table(doc, [
      { header: 'Vehicle / pay unit', width: width * 0.22 },
      { header: 'Operators', width: width * 0.38 },
      { header: 'Rate', width: width * 0.16, align: 'right' },
      { header: 'Weeks', width: width * 0.1, align: 'right' },
      { header: 'Deduction', width: width * 0.14, align: 'right' },
    ], leases.map((lease) => {
      const weeks = lease.frequency === 'WEEKLY' ? Number(lease.weeksCharged || 2) : lease.frequency === 'NONE' ? 0 : 1;
      const deduction = lease.frequency === 'NONE' || !lease.amount ? D(0) : D(lease.amount).times(weeks);
      return {
        cells: [lease.name, (lease.operatorNames || []).join(', ') || lease.name, lease.frequency === 'NONE' ? '-' : fmtMoney(lease.amount), weeks || '-', deduction.isZero() ? '-' : `-${fmtMoney(deduction)}`],
        colors: [C.ink, C.text, C.text, C.text, deduction.isZero() ? C.muted : C.red],
        boldCols: deduction.isZero() ? [] : [4],
      };
    }), { fontSize: 8.2, rowPad: 4 });
  }

  if (calc.steps?.length) {
    ensure(doc, 110 + calc.steps.length * 34);
    sectionTitle(doc, 'Payment summary');
    stepsTable(doc, calc.steps, left, width);
  }
}

function weekExplainCard(doc, w, x, y, width, perTrip) {
  // compact card with the week's steps
  const steps = w.steps || [];
  const rowH = 17;
  const h = 34 + steps.length * rowH + 6;
  doc.roundedRect(x, y, width, h, 7).lineWidth(0.8).strokeColor(C.line).stroke();
  doc.rect(x, y, width, 26).fill(C.soft);
  doc.fillColor(C.navy).font(F.bold).fontSize(9.5).text(`Week ${w.weekNumber}`, x + 12, y + 8.5, { lineBreak: false });
  doc.fillColor(C.muted).font(F.reg).fontSize(8).text(t(`${md(w.start)} – ${md(w.end)}`), x + 60, y + 9.5, { lineBreak: false });
  if (!perTrip && w.performancePercentage) {
    // attainment bar
    const bx = x + width - 112;
    const pct = Math.min(Number(w.performancePercentage), 150);
    doc.roundedRect(bx, y + 10, 100, 6, 3).fill('#dde4ee');
    doc.roundedRect(bx, y + 10, Math.max(2, Math.min(pct, 100)), 6, 3).fill(pct >= 100 ? C.green : C.blue);
    if (pct > 100) doc.roundedRect(bx + 100 - 1, y + 10, 1.5, 6, 0).fill(C.gold);
  }
  let ry = y + 32;
  steps.forEach((s) => {
    const isTotal = s.tone === 'total';
    if (isTotal) {
      doc.moveTo(x + 10, ry - 2).lineTo(x + width - 10, ry - 2).lineWidth(0.8).strokeColor(C.navy).stroke();
    }
    doc.fillColor(isTotal ? C.navy : C.text).font(isTotal || s.tone === 'money' ? F.bold : F.reg).fontSize(8.3)
      .text(t(s.label), x + 12, ry + 2, { width: width * 0.29, height: 10, lineBreak: false, ellipsis: true });
    doc.fillColor(C.muted).font(F.reg).fontSize(7.6)
      .text(t(s.detail), x + 12 + width * 0.29, ry + 2.5, { width: width * 0.43, height: 10, lineBreak: false, ellipsis: true });
    doc.fillColor(isTotal ? C.navy : C.ink).font(isTotal || s.tone === 'money' ? F.bold : F.reg).fontSize(8.3)
      .text(t(s.value), x + width * 0.72, ry + 2, { width: width * 0.28 - 12, height: 10, align: 'right', lineBreak: false });
    ry += rowH;
  });
  return h;
}

/**
 * @param m { status, providerApproval, paidAt, providerDeadline, issues, view } — the staff vdpView
 *          or the provider portalView (same shape). Never includes staff names.
 */
export async function statementPdf(m) {
  const v = m.view || {};
  const tz = v.division?.timezone || 'America/Los_Angeles';
  const stamp = (x) => localDate(x, tz, 'long');
  const calc = v.calculation;
  const uber = calc?.calculationType === 'UBER';
  const perTrip = v.settings?.paymentType?.value === 'PER_TRIP';
  const doc = newDoc('portrait', { Title: `VDP statement ${v.provider?.name || ''} ${cycleText(v.cycle)}` });
  const L = doc.content.left;
  const W = doc.content.width;

  headerBand(doc, {
    title: 'Vendor Direct Payment Statement',
    rightLabel: 'VDP cycle',
    rightTitle: cycleText(v.cycle),
    rightSub: `Payment date ${longDate(v.cycle?.paymentDate)}`,
  });

  // Provider heading + status
  const [statusText, tone] = statusLine(m, stamp);
  doc.fillColor(C.ink).font(F.bold).fontSize(18).text(t(v.provider?.name || 'Provider'), L, 114, { width: W - 230, lineBreak: false, ellipsis: true });
  const idLine = [
    v.provider?.providerNumber && `Provider #${v.provider.providerNumber}`,
    v.provider?.operatorName && `Operator ${v.provider.operatorName}`,
    v.provider?.routes?.length && `Route ${v.provider.routes.join(', ')}`,
  ].filter(Boolean).join('   ·   ');
  doc.fillColor(C.muted).font(F.reg).fontSize(9).text(t(idLine), L, 138, { width: W - 230 });
  chip(doc, statusText, L + W, 118, tone);

  // Details grid + net box
  const top = 166;
  const boxW = 208;
  doc.moveTo(L, top - 8).lineTo(L + W, top - 8).lineWidth(0.6).strokeColor(C.line).stroke();
  const s = v.settings;
  const uberRateStructure = s?.uberConfig?.value?.rateStructureType || 'FLAT';
  const endY = infoGrid(doc, [
    ['Division', v.division ? `DIV ${v.division.divisionNumber} – ${v.division.name}` : '—'],
    ['Service plan', v.plan?.name || '—'],
    ['Payment type', uber ? 'Uber vehicle / pay unit' : perTrip ? 'Per trip' : 'Hourly'],
    ['Contracted hours', uber ? 'Provider profile by vehicle / pay unit' : s?.contractedHours?.value ? `${fmtNum(s.contractedHours.value)} h / week` : '—'],
    ['Base rate', uber && uberRateStructure === 'HOURLY_BANDS' ? 'VDP plan hourly bands' : s?.basePay?.value ? `${fmtRate(s.basePay.value)}${perTrip ? ' / trip' : ' / h'}` : '—'],
    ['Bonus rate', s?.bonusEnabled?.value ? `${fmtRate(s.bonusRate.value)} / h above contract` : 'None'],
    ...(s?.fuelReimbursementEnabled?.value ? [['Fuel reimbursement', `${fmtRate(s.fuelReimbursementRate.value)} / trip`]] : []),
    ...(s?.fuelMethod?.value === 'SERVICE_MILE_ALLOWANCE' ? [['Fuel', `Service mile allowance · ${fmtNum(s.fuelMpg.value)} MPG`]] : []),
  ], L, top, W - boxW - 16, 2);
  netBox(doc, calc, L + W - boxW, top - 2, boxW, 92);
  doc.y = Math.max(endY, top + 92) + 10;

  if (!calc) {
    sectionTitle(doc, 'Statement');
    doc.fillColor(C.muted).font(F.reg).fontSize(10).text('This VDP has not been calculated yet.', L, doc.y);
    footers(doc, `Big Star Transit · VDP statement · ${v.provider?.name || ''} · ${cycleText(v.cycle)}`);
    watermark(doc, 'DRAFT');
    return toBuffer(doc);
  }

  if (uber) {
    uberStatementSections(doc, v, calc, L, W);
  } else {
  // Performance & earnings
  const weeks = calc.weeks;
  sectionTitle(doc, 'Performance & earnings', 'Trips = Total Prov · Hours = Performance Report');
  const colW = (W - 190) / weeks.length;
  const cols = [{ header: '', width: 190 }, ...weeks.map((w) => ({ header: `Week ${w.weekNumber}  ${md(w.start)}–${md(w.end)}`, width: colW, align: 'right' }))];
  const row = (label, fn, extra = {}) => ({ cells: [label, ...weeks.map(fn)], labelBold: false, ...extra });
  const perfRows = perTrip
    ? [
        row('Trips provided', (w) => fmtNum(w.trips)),
        row('Hours worked', (w) => hrs(w.actualHours)),
        row('Rate per trip', (w) => rateOrOps(w.incentiveRate), { boldCols: weeks.map((_, i) => i + 1) }),
        row('Trip pay', (w) => fmtMoney(w.coreEarnings)),
      ]
    : [
        row('Trips provided', (w) => fmtNum(w.trips)),
        row('Hours worked', (w) => hrs(w.actualHours), { boldCols: weeks.map((_, i) => i + 1) }),
        row('Contracted hours', (w) => hrs(w.contractedHours)),
        row('Performance', (w) => pctText(w.performancePercentage)),
        row('Incentive tier', (w) => w.tierLabel, { style: 'muted' }),
        row('Hourly rate', (w) => rateOrOps(w.incentiveRate), { boldCols: weeks.map((_, i) => i + 1) }),
        row('Core pay', (w) => `${fmtNum(w.corePaidHours)} h  ·  ${fmtMoney(w.coreEarnings)}`),
        row('Bonus pay', (w) => `${fmtNum(w.bonusHours)} h  ·  ${fmtMoney(w.bonusEarnings)}`),
      ];
  perfRows.push({ cells: ['Week total', ...weeks.map((w) => fmtMoney(w.weeklyEarnings))], style: 'total' });
  table(doc, cols, perfRows);

  // Several operators: each one is measured against their own contract.
  const ops = calc.operators || [];
  if (ops.length > 1) {
    ensure(doc, 60 + ops.length * 22);
    sectionTitle(doc, 'By operator', 'Each operator’s hours are measured against their own contracted hours');
    const opW = [W * 0.22, W * 0.1, ...weeks.map(() => (W * 0.46) / weeks.length), W * 0.11, W * 0.11];
    table(doc, [
      { header: 'Operator', width: opW[0] },
      { header: 'Route', width: opW[1] },
      ...weeks.map((w, i) => ({ header: `Week ${w.weekNumber}`, width: opW[2 + i], align: 'right' })),
      { header: 'Earned', width: opW[2 + weeks.length], align: 'right' },
      { header: 'Lease', width: opW[3 + weeks.length], align: 'right' },
    ], ops.map((o) => ({
      cells: [
        o.plan ? `${o.name} (${o.plan.name})` : o.name,
        (o.routes || []).join(', ') || '—',
        ...o.weeks.map((w) => ((o.paymentType ? o.paymentType === 'PER_TRIP' : perTrip)
          ? `${fmtNum(w.trips)} trips · ${fmtMoney(w.weeklyEarnings)}`
          : `${fmtNum(w.actualHours)} h · ${pctText(w.performancePercentage)} · ${fmtMoney(w.weeklyEarnings)}`)),
        fmtMoney(o.earnings),
        o.lease !== '0.00' ? `–${fmtMoney(o.lease)}` : '—',
      ],
    })), { fontSize: 8.2, rowPad: 5 });
  }

  // Payment summary
  if (calc.steps?.length) {
    sectionTitle(doc, 'Payment summary');
    stepsTable(doc, calc.steps, L, W);
  }

  // How it was calculated
  if (weeks.every((w) => w.steps?.length)) {
    const cardW = (W - 14) / 2;
    const est = 34 + Math.max(...weeks.map((w) => w.steps.length)) * 17 + 10;
    ensure(doc, est + 40);
    sectionTitle(doc, 'How your pay was calculated', 'Each week is calculated on its own');
    const y = doc.y;
    const heights = weeks.map((w, i) => weekExplainCard(doc, w, L + i * (cardW + 14), y, cardW, perTrip));
    doc.y = y + Math.max(...heights) + 12;

    // Tier ladder
    const tiers = s?.incentiveTiers?.value || [];
    if (s?.tuiEligible?.value && tiers.length) {
      ensure(doc, 30 + tiers.length * 21);
      doc.fillColor(C.text).font(F.bold).fontSize(8.6).text('Incentive tiers (% of contracted hours)', L, doc.y);
      doc.y += 4;
      table(doc, [
        { header: 'Performance', width: W * 0.4 },
        { header: perTrip ? 'Rate per trip' : 'Hourly rate', width: W * 0.25, align: 'right' },
        { header: 'Reached', width: W * 0.35, align: 'right' },
      ], tiers.map((tier, i) => {
        const hit = ops.length > 1
          ? ops.flatMap((o) => o.weeks.filter((w) => w.tierIndex === i).map((w) => `${o.name} wk ${w.weekNumber}`))
          : weeks.filter((w) => w.tierIndex === i).map((w) => `Week ${w.weekNumber}`);
        return {
          cells: [
            tier.maximumPercentage ? `${fmtNum(tier.minimumPercentage)}% – ${fmtNum(tier.maximumPercentage)}%` : `${fmtNum(tier.minimumPercentage)}% and above`,
            fmtRate(tier.rate),
            hit.length ? hit.join(' & ') : '',
          ],
          fill: hit.length ? C.greenSoft : undefined,
          colors: [C.ink, C.ink, C.green],
          boldCols: hit.length ? [0, 1, 2] : [],
          labelBold: false,
        };
      }), { fontSize: 8.4, rowPad: 5 });
    }
  }

  }

  // Adjustments detail
  if (v.adjustments?.length) {
    sectionTitle(doc, uber ? 'Adjustments, toll credits and toll bills' : 'Deductions & additions detail');
    const ADD = new Set(['REIMBURSEMENT', 'OTHER_INCOME']);
    table(doc, [
      { header: 'Type', width: W * 0.13 },
      { header: 'Description', width: W * 0.6 },
      { header: 'Date', width: W * 0.12 },
      { header: 'Amount', width: W * 0.15, align: 'right' },
    ], v.adjustments.map((a) => {
      const addition = ADD.has(a.type) || (uber && a.type === 'TOLL' && a.tollDirection !== 'DEDUCTION');
      const assignment = a.operatorName ? `${a.operatorName}${a.week ? ` - week of ${shortDate(a.week)}` : ''}` : '';
      return {
        cells: [
          uber && a.type === 'TOLL' ? (addition ? 'Toll credit' : 'Toll bill') : a.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
          [assignment, a.description].filter(Boolean).join(' - ') || '—',
          uber && a.type === 'TOLL' ? md(a.date) : shortDate(a.date),
          `${addition ? '+' : '-'}${fmtMoney(a.amount)}`,
        ],
        colors: [C.ink, C.text, C.muted, addition ? C.green : C.red],
        boldCols: [3],
      };
    }));
  }

  // Service mile fuel allowance
  const fa = calc.fuelAllowance;
  if (fa) {
    ensure(doc, 200);
    sectionTitle(doc, 'Fuel allowance', 'Service miles ÷ MPG × fuel price on each service date');
    const entered = fa.actualExpense !== null;
    const over = Number(calc.fuelOverspend) > 0;
    stepsTable(doc, [
      { label: 'Service miles', detail: `Week 1 ${fmtNum(fa.weekMiles[0])} + week 2 ${fmtNum(fa.weekMiles[1])}`, value: fmtNum(fa.serviceMiles), tone: 'info' },
      { label: 'Fuel efficiency', detail: fa.mpg ? 'VDP plan' : 'Each operator’s VDP plan', value: `${fa.mpg ? fmtNum(fa.mpg) : fa.mpgs.join(' / ')} MPG`, tone: 'info' },
      { label: 'Allowed gallons', detail: fa.mpg ? `${fmtNum(fa.serviceMiles)} ÷ ${fmtNum(fa.mpg)}` : 'Each operator’s miles ÷ their MPG', value: D(fa.gallons).toFixed(4), tone: 'info' },
      { label: 'Fuel price', detail: 'In effect on each service date', value: fa.pricesUsed.map((pr) => `${fmtRate(pr)}/gal`).join(', '), tone: 'info' },
      { label: 'Maximum allowed fuel', detail: '', value: fmtMoney(fa.maxAllowed), tone: 'subtotal' },
      { label: 'Actual fuel expense', detail: '', value: entered ? fmtMoney(fa.actualExpense) : 'Not entered', tone: 'info' },
      { label: 'Fuel overspend deduction', detail: over ? `${fmtMoney(fa.actualExpense)} − ${fmtMoney(fa.maxAllowed)}` : 'Within the allowance', value: over ? `–${fmtMoney(calc.fuelOverspend)}` : fmtMoney(0), tone: over ? 'minus' : 'total' },
    ], L, W);
    ensure(doc, 40 + fa.days.length * 15);
    table(doc, [
      { header: 'Date', width: W * 0.2 },
      { header: 'Service miles', width: W * 0.16, align: 'right' },
      { header: 'MPG', width: W * 0.1, align: 'right' },
      { header: 'Allowed gallons', width: W * 0.18, align: 'right' },
      { header: 'Fuel price', width: W * 0.16, align: 'right' },
      { header: 'Allowed fuel', width: W * 0.2, align: 'right' },
    ], fa.days.map((d) => ({
      cells: [shortDate(d.date), fmtNum(d.serviceMiles), fmtNum(d.mpg), D(d.gallons).toFixed(6), fmtRate(d.pricePerGallon), D(d.allowed).toFixed(4)],
      labelBold: false,
    })), { fontSize: 8, rowPad: 3 });
  }

  // Issues reported by the provider
  if (m.issues?.length) {
    sectionTitle(doc, 'Issues reported');
    m.issues.forEach((issue, n) => {
      ensure(doc, 70);
      doc.fillColor(C.ink).font(F.bold).fontSize(9)
        .text(t(`Issue ${n + 1} · reported ${stamp(issue.raisedAt)}`), L, doc.y);
      doc.y += 3;
      table(doc, [
        { header: 'What', width: W * 0.22 },
        { header: 'Statement shows', width: W * 0.22 },
        { header: 'Should be', width: W * 0.16 },
        { header: 'Why', width: W * 0.4 },
      ], issue.items.map((it) => ({
        cells: [`${it.areaLabel || ISSUE_AREAS[it.area] || it.area}${it.week ? ` (week ${it.week})` : ''}`, it.shownValue || '—', it.expectedValue || '—', it.reason],
        colors: [C.ink, C.text, C.ink, C.text],
      })), { fontSize: 8.2, rowPad: 5 });
      const r = issue.response;
      if (r?.action) {
        ensure(doc, 34);
        doc.fillColor(r.action === 'CORRECTED' ? C.green : C.navy).font(F.bold).fontSize(8.4)
          .text(r.action === 'CORRECTED' ? `Corrected by Big Star${r.newNet ? ` · new net ${fmtMoney(r.newNet)}` : ''}` : 'Big Star response (no change)', L, doc.y);
        doc.fillColor(C.text).font(F.reg).fontSize(8.4).text(t(r.message || ''), L, doc.y + 2, { width: W });
        doc.y += 8;
      }
    });
  }

  // Approval trail
  ensure(doc, 60);
  sectionTitle(doc, 'Approval');
  const trail = [
    ['Approved by Big Star', v.approvedAt ? stamp(v.approvedAt) : 'Not yet approved'],
    ['Provider approval', m.providerApproval?.method === 'AUTO'
      ? `Auto-approved ${stamp(m.providerApproval.at)} (no response by the Closed for Submission date)`
      : m.providerApproval?.method === 'PROVIDER' ? `Approved ${stamp(m.providerApproval.at)}` : `Due by end of ${longDate(v.cycle?.submissionDate)}`],
    ['Payment', m.paidAt ? `Paid ${stamp(m.paidAt)}` : `Scheduled ${longDate(v.cycle?.paymentDate)}`],
  ];
  trail.forEach(([k, val]) => {
    const y = doc.y;
    doc.fillColor(C.muted).font(F.reg).fontSize(8.4).text(t(k), L, y, { width: 150 });
    doc.fillColor(C.ink).font(F.bold).fontSize(8.4).text(t(val), L + 150, y, { width: W - 150 });
    doc.y = Math.max(doc.y, y + 11) + 4;
  });

  footers(doc, `Big Star Transit · VDP statement · ${v.provider?.name || ''} · ${cycleText(v.cycle)} · Generated ${stamp(new Date())}`);
  if (v.source !== 'SNAPSHOT') watermark(doc, 'DRAFT — NOT APPROVED');
  return toBuffer(doc);
}

export const statementFileName = (m) =>
  `VDP Statement - ${(m.view?.provider?.name || 'Provider').replace(/[^\w .,&-]/g, '')} - ${isoDate(m.view?.cycle?.cycleStart || new Date())}.pdf`;

// ---------- register ----------

const STATUS_LABEL = {
  DRAFT: 'Draft', NEEDS_REVIEW: 'Needs review', READY: 'Ready', APPROVED: 'Awaiting provider',
  DISPUTED: 'Issue reported', PROCESSED: 'Processed', PAID: 'Paid',
};
const STATUS_COLOR = { NEEDS_REVIEW: C.red, DISPUTED: C.red, APPROVED: C.amber, PROCESSED: C.green, PAID: C.blue };

export async function registerPdf(cycleId) {
  const { cycle, division, entries } = await loadRegister(cycleId);
  const doc = newDoc('landscape', { Title: `VDP register DIV ${division.divisionNumber} ${isoDate(cycle.cycleStart)}` });
  const L = doc.content.left;
  const W = doc.content.width;

  headerBand(doc, {
    title: 'VDP Payment Register',
    rightLabel: `DIV ${division.divisionNumber} – ${division.name}`,
    rightTitle: cycleText(cycle),
    rightSub: `Closed for submission ${longDate(cycle.submissionDate)}  ·  Payment ${longDate(cycle.paymentDate)}`,
  });

  // summary tiles
  const calcs = entries.map((e) => e.calc).filter(Boolean);
  const tiles = [
    ['VDPs', `${entries.length}`],
    ['Gross VDP', fmtMoney(money(sum(calcs.map((c) => c.gross))))],
    ['Deductions', fmtMoney(money(sum(calcs.map((c) => c.totalDeductions))))],
    ['Additions', fmtMoney(money(sum(calcs.map((c) => c.totalAdditions))))],
    ['Net VDP', fmtMoney(money(sum(calcs.map((c) => c.net))))],
  ];
  const tileW = (W - 4 * 10) / 5;
  const ty = 110;
  tiles.forEach(([k, val], i) => {
    const x = L + i * (tileW + 10);
    const last = i === tiles.length - 1;
    doc.roundedRect(x, ty, tileW, 44, 7).fill(last ? C.navy : C.soft);
    doc.fillColor(last ? C.gold : C.muted).font(F.bold).fontSize(7).text(k.toUpperCase(), x + 12, ty + 9, { characterSpacing: 1 });
    doc.fillColor(last ? '#ffffff' : C.ink).font(F.bold).fontSize(14).text(t(val), x + 12, ty + 20, { width: tileW - 24, lineBreak: false });
  });
  const counts = entries.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] || 0) + 1 }), {});
  doc.fillColor(C.muted).font(F.reg).fontSize(8.2)
    .text(t(Object.entries(counts).map(([k, n]) => `${STATUS_LABEL[k] || k}: ${n}`).join('   ·   ')), L, ty + 52, { width: W });
  doc.y = ty + 68;

  const cols = [
    { header: 'Provider', width: 142 },
    { header: 'Route', width: 46 },
    { header: 'Wk 1', width: 42, align: 'right' },
    { header: 'Wk 2', width: 42, align: 'right' },
    { header: 'Gross', width: 64, align: 'right' },
    { header: 'Lease', width: 64, align: 'right' },
    { header: 'Fares', width: 46, align: 'right' },
    { header: 'Other', width: 46, align: 'right' },
    { header: 'Added', width: 46, align: 'right' },
    { header: 'Net VDP', width: 64, align: 'right' },
  ];
  const used = cols.reduce((a, c) => a + c.width, 0);
  cols.push({ header: 'Status', width: W - used });

  const rows = entries.map((e) => {
    const c = e.calc;
    const w = (i) => c?.weeks?.[i];
    return {
      cells: [
        e.provider.name,
        (e.provider.routes || []).join(', '),
        w(0) ? fmtNum(w(0).actualHours) : '—',
        w(1) ? fmtNum(w(1).actualHours) : '—',
        mny(c?.gross), c ? `–${fmtMoney(c.lease)}` : '—', c && c.fares !== '0.00' ? `–${fmtMoney(c.fares)}` : '—',
        c && otherOf(c) !== '0.00' ? `–${fmtMoney(otherOf(c))}` : '—',
        c && c.totalAdditions !== '0.00' ? `+${fmtMoney(c.totalAdditions)}` : '—',
        mny(c?.net),
        STATUS_LABEL[e.status] || e.status,
      ],
      sub: [
        [e.planName, e.provider.operatorName].filter(Boolean).join(' · '),
        '', w(0) ? `${fmtNum(w(0).trips)} trips` : '', w(1) ? `${fmtNum(w(1).trips)} trips` : '',
        '', '', '', '', '', '', e.approval,
      ],
      colors: [C.ink, C.text, C.text, C.text, C.ink, C.red, C.red, C.red, C.green, C.navy, STATUS_COLOR[e.status] || C.text],
      boldCols: [9, 10],
    };
  });
  const otherTotal = () => {
    const v = money(sum(calcs.map(otherOf)));
    return v === '0.00' ? '—' : `–${fmtMoney(v)}`;
  };
  const total = (key, sign) => {
    const v = money(sum(calcs.map((c) => c[key])));
    return v === '0.00' ? '—' : `${sign}${fmtMoney(v)}`;
  };
  rows.push({
    cells: [
      'Total', '', '', '',
      total('gross', ''), total('lease', '–'), total('fares', '–'), otherTotal(), total('totalAdditions', '+'),
      total('net', ''), '',
    ],
    style: 'total',
  });
  table(doc, cols, rows, { fontSize: 8.4, rowPad: 4, totalBump: 0 });
  doc.fillColor(C.muted).font(F.reg).fontSize(7.5)
    .text('Wk 1 / Wk 2 = hours worked (trips below). Lease, Fares and Other are deductions; Added = fuel reimbursement, reimbursements and other income.', L, doc.y + 2, { width: W });

  footers(doc, `Big Star Transit · VDP payment register · DIV ${division.divisionNumber} – ${division.name} · ${cycleText(cycle)} · Generated ${localDate(new Date(), division.timezone)}`);
  return {
    buffer: await toBuffer(doc),
    fileName: `VDP Register DIV ${division.divisionNumber} ${isoDate(cycle.cycleStart)} to ${isoDate(cycle.cycleEnd)}.pdf`,
  };
}

// ---------- company VDP cycle schedule ----------
const CYCLE_LABEL = {
  UPCOMING: 'Upcoming', OPEN: 'Open', PROCESSING: 'Processing', READY_FOR_REVIEW: 'Ready for review',
  APPROVED: 'Approved', PAID: 'Paid', CLOSED: 'Closed',
};

/**
 * Company-wide VDP cycle schedule: one row per period (same dates for every division),
 * with each division's status. `year` limits it to cycles starting in that year.
 */
export async function cycleSchedulePdf({ year, schedule } = {}) {
  const [cycles, divisions] = await Promise.all([
    VdpCycle.find().sort({ cycleStart: 1 }),
    Division.find({ status: 'ACTIVE' }).sort({ divisionNumber: 1 }),
  ]);
  const divNumber = new Map(divisions.map((d) => [String(d._id), d.divisionNumber]));
  const periods = new Map();
  for (const c of cycles) {
    if (year && c.cycleStart.getUTCFullYear() !== Number(year)) continue;
    const key = isoDate(c.cycleStart);
    if (!periods.has(key)) periods.set(key, { ...c.toObject(), statuses: [] });
    if (divNumber.has(String(c.divisionId))) periods.get(key).statuses.push({ div: divNumber.get(String(c.divisionId)), status: c.status });
  }
  const rows = [...periods.values()];

  const doc = newDoc('landscape', { Title: `VDP cycle schedule${year ? ` ${year}` : ''}` });
  const L = doc.content.left;
  const W = doc.content.width;
  headerBand(doc, {
    title: 'VDP Cycle Schedule',
    rightLabel: 'Company-wide · all divisions',
    rightTitle: year ? `${year}` : rows.length ? `${shortDate(rows[0].cycleStart)} – ${shortDate(rows[rows.length - 1].cycleEnd)}` : 'No cycles yet',
    rightSub: `${rows.length} cycle${rows.length === 1 ? '' : 's'}  ·  ${divisions.length} division${divisions.length === 1 ? '' : 's'}`,
  });
  if (schedule) {
    doc.fillColor(C.muted).font(F.reg).fontSize(8.5).text(t(
      `Cycles are ${schedule.lengthDays} days: two invoice weeks, Monday to Sunday, with the same dates for every division. `
      + 'Providers approve their VDP by the end of the Closed for Submission date; payment is made on the payment date.',
    ), L, doc.y, { width: W });
    doc.y += 8;
  }

  const today = isoDate(new Date());
  const statusText = (p) => {
    const distinct = [...new Set(p.statuses.map((s) => s.status))];
    if (distinct.length === 1) return CYCLE_LABEL[distinct[0]] || distinct[0];
    return p.statuses.map((s) => `DIV ${s.div} ${CYCLE_LABEL[s.status] || s.status}`).join(' · ');
  };
  const widths = [34, 150, 92, 92, 128, 118];
  const cols = [
    { header: '#', width: widths[0] },
    { header: 'VDP cycle', width: widths[1] },
    { header: 'Week 1', width: widths[2] },
    { header: 'Week 2', width: widths[3] },
    { header: 'Closed for submission', width: widths[4] },
    { header: 'Payment date', width: widths[5] },
    { header: 'Status', width: W - widths.reduce((a, b) => a + b, 0) },
  ];
  if (!rows.length) {
    doc.fillColor(C.muted).font(F.reg).fontSize(10).text('No VDP cycles have been generated for this period.', L, doc.y + 10);
  } else {
    table(doc, cols, rows.map((p, i) => {
      const current = isoDate(p.cycleStart) <= today && today <= isoDate(p.cycleEnd);
      return {
        cells: [
          `${i + 1}`,
          cycleText(p),
          `${md(p.week1Start)} – ${md(p.week1End)}`,
          `${md(p.week2Start)} – ${md(p.week2End)}`,
          longDate(p.submissionDate),
          longDate(p.paymentDate),
          current ? `Current · ${statusText(p)}` : statusText(p),
        ],
        fill: current ? C.greenSoft : undefined,
        boldCols: [1, 5],
        labelBold: false,
      };
    }), { fontSize: 8.8, rowPad: 6 });
  }
  footers(doc, `Big Star Transit · VDP cycle schedule${year ? ` ${year}` : ''} · Generated ${localDate(new Date(), 'America/Los_Angeles')}`);
  return { buffer: await toBuffer(doc), fileName: `VDP Cycle Schedule${year ? ` ${year}` : ''}.pdf` };
}

// ---------- VDP plan executive report ----------

const planFilePart = (value) => String(value || 'Plan').replace(/[^\w .,&-]/g, '').trim();
const ratioPct = (value) => (value === null || value === undefined || value === '' ? '-' : `${fmtNum(D(value).mul(100), 4)}%`);
const effectiveRange = (version) => `${longDate(version.effectiveFrom)} - ${version.effectiveTo ? longDate(version.effectiveTo) : 'Open-ended'}`;

const PAYMENT_LABELS = { HOURLY: 'Hourly', PER_TRIP: 'Per trip' };
const PERFORMANCE_LABELS = {
  TOTAL_HOURS: 'Total hours', SERVICE_HOURS: 'Service hours', REVENUE_HOURS: 'Revenue hours', OTHER: 'Other report column',
};

function planSummaryRows(version) {
  if (version.calculationType === 'UBER') {
    const u = uberConfigOf(version.uberConfig);
    return [
      ['Compensation model', u.rateStructureType === 'HOURLY_BANDS' ? `Uber - ${u.hourlyRateBands.length} hourly rate band(s)` : 'Uber - flat operator-profile rate'],
      ['Core compensation', `${ratioPct(u.coreRatePct)} of base hourly rate`],
      ['Incentive qualification', `${ratioPct(u.minimumFulfillmentForIncentives)} minimum fulfillment`],
      ['Below threshold', u.belowThresholdBehavior === 'CORE_ONLY' ? 'Core compensation only' : 'Driver fares only'],
      ['Utilization incentive', u.utilizationEnabled ? `${ratioPct(u.utilizationIncentivePct)} at ${ratioPct(u.utilizationTarget)} utilization` : 'Disabled'],
      ['Core-hours rule', u.coreHoursRuleType === 'PERCENTAGE' ? `${ratioPct(u.coreHoursRequirement)} of contracted hours` : u.coreHoursRuleType === 'CONTINUOUS_COVERAGE' ? 'Continuous coverage validation' : 'None'],
    ];
  }
  const fuel = fuelMethodOf(version);
  const unit = version.paymentType === 'HOURLY' ? 'hour' : 'trip';
  const metric = version.performanceHourMetric === 'OTHER'
    ? `${PERFORMANCE_LABELS.OTHER}: ${version.performanceHourColumn || '-'}`
    : PERFORMANCE_LABELS[version.performanceHourMetric] || version.performanceHourMetric || '-';
  const fuelText = fuel === 'PER_TRIP'
    ? `${fmtRate(version.fuelReimbursementRate)} per trip reimbursement`
    : fuel === 'SERVICE_MILE_ALLOWANCE' ? `Service-mile allowance at ${fmtNum(version.fuelMpg)} MPG` : 'None';
  return [
    ['Compensation model', PAYMENT_LABELS[version.paymentType] || version.paymentType],
    ['Base pay', `${fmtRate(version.basePay)} per ${unit}`],
    ['Contracted hours', version.contractedHours ? `${fmtNum(version.contractedHours)} per week` : 'Not configured'],
    ['TUI incentive', version.incentiveEnabled ? `Enabled - ${version.incentiveTiers.length} tier(s)` : 'Disabled'],
    ['Bonus', version.bonusEnabled ? `${fmtRate(version.bonusRate)} per hour above contract` : 'Disabled'],
    ['Performance hours source', metric],
    ['Fuel arrangement', fuelText],
  ];
}

function detailTable(doc, rows) {
  table(doc, [
    { header: 'Setting', width: 182 },
    { header: 'Plan rule', width: doc.content.width - 182 },
  ], rows.map(([key, value]) => ({ cells: [key, value], labelBold: false, boldCols: [1] })), { fontSize: 8.8, rowPad: 5 });
}

function reportNote(doc, text) {
  if (!text) return;
  doc.font(F.reg).fontSize(8.6);
  const value = t(text);
  const height = doc.heightOfString(value, { width: doc.content.width - 24 }) + 20;
  ensure(doc, height + 4);
  const y = doc.y;
  doc.roundedRect(doc.content.left, y, doc.content.width, height, 6).fill(C.soft);
  doc.fillColor(C.text).font(F.reg).fontSize(8.6).text(value, doc.content.left + 12, y + 10, { width: doc.content.width - 24 });
  doc.y = y + height + 7;
}

function standardVersionDetails(doc, version) {
  if (version.incentiveTiers?.length) {
    doc.fillColor(C.navy).font(F.bold).fontSize(8.5).text('TUI INCENTIVE TIERS', doc.content.left, doc.y + 3, { characterSpacing: 0.6 });
    doc.y += 16;
    table(doc, [
      { header: 'Minimum performance', width: 174 },
      { header: 'Maximum performance', width: 174 },
      { header: 'Hourly rate', width: doc.content.width - 348, align: 'right' },
    ], version.incentiveTiers.map((tier) => ({
      cells: [
        `${fmtNum(tier.minimumPercentage)}%`,
        tier.maximumPercentage === null || tier.maximumPercentage === undefined ? 'And above' : `${fmtNum(tier.maximumPercentage)}%`,
        fmtRate(tier.rate),
      ],
      labelBold: false,
      boldCols: [2],
    })), { fontSize: 8.6, rowPad: 5 });
  }
}

function uberVersionDetails(doc, version) {
  const u = uberConfigOf(version.uberConfig);
  if (u.rateStructureType === 'HOURLY_BANDS' && u.hourlyRateBands.length) {
    doc.fillColor(C.navy).font(F.bold).fontSize(8.5).text('HOURLY RATE BANDS', doc.content.left, doc.y + 3, { characterSpacing: 0.6 });
    doc.y += 16;
    table(doc, [
      { header: 'From hour', width: 170 }, { header: 'To hour', width: 170 },
      { header: 'Hourly rate', width: doc.content.width - 340, align: 'right' },
    ], u.hourlyRateBands.map((band) => ({
      cells: [fmtNum(band.fromHour), fmtNum(band.toHour), fmtRate(band.hourlyRate)], labelBold: false, boldCols: [2],
    })), { fontSize: 8.6, rowPad: 5 });
  }

  const tierGroups = [
    ['CONTRACT-HOURS INCENTIVES', 'Minimum fulfillment', u.contractHoursIncentiveTiers, 'minimum'],
    ['ACCEPTANCE INCENTIVES', 'Minimum acceptance', u.acceptanceIncentiveTiers, 'minimum'],
    ['CANCELLATION INCENTIVES', 'Maximum cancellation', u.cancellationIncentiveTiers, 'maximum'],
  ];
  tierGroups.forEach(([title, thresholdTitle, tiers, key]) => {
    if (!tiers?.length) return;
    doc.fillColor(C.navy).font(F.bold).fontSize(8.5).text(title, doc.content.left, doc.y + 3, { characterSpacing: 0.6 });
    doc.y += 16;
    table(doc, [
      { header: thresholdTitle, width: 260 },
      { header: 'Incentive rate', width: doc.content.width - 260, align: 'right' },
    ], tiers.map((tier) => ({
      cells: [ratioPct(tier[key]), ratioPct(tier.rate)], labelBold: false, boldCols: [1],
    })), { fontSize: 8.6, rowPad: 5 });
  });
}

/** Executive overview and complete rule history for one VDP plan. */
export async function planReportPdf(planId) {
  const plan = await VdpPlan.findById(planId);
  if (!plan) throw notFound('VDP plan');
  const [division, providerCount] = await Promise.all([
    Division.findById(plan.divisionId),
    Provider.countDocuments({ planId: plan._id, status: 'ACTIVE' }),
  ]);
  if (!division) throw notFound('Division');

  const current = currentVersion(plan);
  const versions = [...plan.versions].sort((a, b) => b.versionNumber - a.versionNumber);
  const generated = localDate(new Date(), division.timezone);
  const doc = newDoc('portrait', { Title: `VDP plan executive report - ${plan.name}` });
  const L = doc.content.left;
  const W = doc.content.width;

  headerBand(doc, {
    title: 'VDP Plan Executive Report',
    rightLabel: `DIV ${division.divisionNumber} - ${division.name}`,
    rightTitle: plan.name,
    rightSub: `${plan.status === 'ACTIVE' ? 'Active plan' : 'Inactive plan'} - Generated ${generated}`,
  });

  chip(doc, plan.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE', L + W, 110, plan.status === 'ACTIVE' ? 'ok' : 'draft');
  doc.fillColor(C.muted).font(F.reg).fontSize(8.5)
    .text('Executive overview of the current compensation model, supporting schedules, and complete plan-version history.', L, 113, { width: W - 95 });
  doc.y = 145;

  const tileValues = [
    ['ACTIVE PROVIDERS', `${providerCount}`],
    ['PLAN VERSIONS', `${versions.length}`],
    ['CURRENT VERSION', current ? `Version ${current.versionNumber}` : '-'],
    ['EFFECTIVE SINCE', current ? shortDate(current.effectiveFrom) : '-'],
  ];
  const tileGap = 8;
  const tileW = (W - tileGap * 3) / 4;
  const tileY = doc.y;
  tileValues.forEach(([label, value], index) => {
    const x = L + index * (tileW + tileGap);
    doc.roundedRect(x, tileY, tileW, 43, 6).fill(index === 2 ? C.navy : C.soft);
    doc.fillColor(index === 2 ? C.gold : C.muted).font(F.bold).fontSize(6.7).text(label, x + 10, tileY + 9, { width: tileW - 20, characterSpacing: 0.6, lineBreak: false });
    doc.fillColor(index === 2 ? '#ffffff' : C.ink).font(F.bold).fontSize(12).text(value, x + 10, tileY + 22, { width: tileW - 20, lineBreak: false, ellipsis: true });
  });
  doc.y = tileY + 55;

  if (current) {
    sectionTitle(doc, 'Current compensation model', effectiveRange(current));
    const rows = planSummaryRows(current);
    rows.push(['Version owner', current.createdBy?.name || 'System']);
    rows.push(['Created', current.createdAt ? longDate(current.createdAt) : '-']);
    detailTable(doc, rows);
    if (current.notes) reportNote(doc, `Version notes: ${current.notes}`);
    if (current.calculationType === 'UBER') uberVersionDetails(doc, current);
    else standardVersionDetails(doc, current);
  }

  if (plan.notes) {
    sectionTitle(doc, 'Plan notes');
    reportNote(doc, plan.notes);
  }

  sectionTitle(doc, 'Version history', `${versions.length} version${versions.length === 1 ? '' : 's'} - newest first`);
  table(doc, [
    { header: 'Version', width: 100 },
    { header: 'Effective period', width: 180 },
    { header: 'Model', width: 100 },
    { header: 'Created by', width: W - 380 },
  ], versions.map((version) => ({
    cells: [
      `Version ${version.versionNumber}${current && String(current._id) === String(version._id) ? ' (Current)' : ''}`,
      effectiveRange(version),
      version.calculationType === 'UBER' ? 'Uber' : PAYMENT_LABELS[version.paymentType] || version.paymentType,
      version.createdBy?.name || 'System',
    ],
    labelBold: false,
    boldCols: [0],
  })), { fontSize: 8.2, rowPad: 5 });

  const historical = versions.filter((version) => !current || String(current._id) !== String(version._id));
  if (historical.length) sectionTitle(doc, 'Historical version details', `${historical.length} superseded version${historical.length === 1 ? '' : 's'}`);
  historical.forEach((version) => {
    ensure(doc, 125);
    const headingY = doc.y;
    doc.fillColor(C.navy).font(F.bold).fontSize(11).text(`Version ${version.versionNumber}`, L, headingY, { width: W - 150 });
    doc.fillColor(C.muted).font(F.bold).fontSize(8).text(version.calculationType === 'UBER' ? 'UBER' : String(PAYMENT_LABELS[version.paymentType] || version.paymentType).toUpperCase(), L + W - 145, headingY + 1, { width: 145, align: 'right' });
    doc.fillColor(C.muted).font(F.reg).fontSize(8.2).text(effectiveRange(version), L, headingY + 17, { width: W });
    doc.y = headingY + 34;

    const rows = planSummaryRows(version);
    rows.push(['Version owner', version.createdBy?.name || 'System']);
    rows.push(['Created', version.createdAt ? longDate(version.createdAt) : '-']);
    detailTable(doc, rows);
    if (version.notes) reportNote(doc, `Version notes: ${version.notes}`);
    if (version.calculationType === 'UBER') uberVersionDetails(doc, version);
    else standardVersionDetails(doc, version);
    doc.y += 5;
  });

  if (plan.fuelPrices?.length) {
    sectionTitle(doc, 'Fuel price schedule', 'Plan-level prices used by service-mile allowance versions');
    table(doc, [
      { header: 'Effective from', width: 145 },
      { header: 'Effective to', width: 145 },
      { header: 'Price per gallon', width: 120, align: 'right' },
      { header: 'Notes', width: W - 410 },
    ], [...plan.fuelPrices].sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom))).map((price) => ({
      cells: [shortDate(price.effectiveFrom), price.effectiveTo ? shortDate(price.effectiveTo) : 'Open-ended', fmtRate(price.pricePerGallon), price.notes || ''],
      labelBold: false,
      boldCols: [2],
    })), { fontSize: 8.4, rowPad: 5 });
  }

  ensure(doc, 105);
  sectionTitle(doc, 'Report scope');
  reportNote(doc, 'This report documents plan-level compensation rules and version history. Provider and operator profile overrides are applied during VDP calculation and are not included in these plan-level figures. Approved VDPs retain the version and settings snapshot used for their calculation.');

  footers(doc, `Big Star Transit - VDP plan executive report - ${plan.name} - DIV ${division.divisionNumber} - Generated ${generated}`);
  return {
    buffer: await toBuffer(doc),
    fileName: `VDP Plan Executive Report - DIV ${planFilePart(division.divisionNumber)} - ${planFilePart(plan.name)}.pdf`,
  };
}

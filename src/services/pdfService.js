// PDF reports: the provider VDP statement and the cycle payment register.
// Built with pdfkit's standard Helvetica (WinAnsi), so text is sanitised to that character set.
import PDFDocument from 'pdfkit';
import { loadRegister } from './exportService.js';
import { isoDate, localDate } from './cycleService.js';
import { fmtMoney, fmtNum, fmtRate, sum, money } from './money.js';
import { ISSUE_AREAS } from '../models/Vdp.js';

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
  const endY = infoGrid(doc, [
    ['Division', v.division ? `DIV ${v.division.divisionNumber} – ${v.division.name}` : '—'],
    ['Service plan', v.plan?.name || '—'],
    ['Payment type', perTrip ? 'Per trip' : 'Hourly'],
    ['Contracted hours', s?.contractedHours?.value ? `${fmtNum(s.contractedHours.value)} h / week` : '—'],
    [perTrip ? 'Base rate' : 'Base rate', s?.basePay?.value ? `${fmtRate(s.basePay.value)}${perTrip ? ' / trip' : ' / h'}` : '—'],
    ['Bonus rate', s?.bonusEnabled?.value ? `${fmtRate(s.bonusRate.value)} / h above contract` : 'None'],
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
        row('Rate per trip', (w) => fmtRate(w.incentiveRate), { boldCols: weeks.map((_, i) => i + 1) }),
        row('Trip pay', (w) => fmtMoney(w.coreEarnings)),
      ]
    : [
        row('Trips provided', (w) => fmtNum(w.trips)),
        row('Hours worked', (w) => hrs(w.actualHours), { boldCols: weeks.map((_, i) => i + 1) }),
        row('Contracted hours', (w) => hrs(w.contractedHours)),
        row('Performance', (w) => pctText(w.performancePercentage)),
        row('Incentive tier', (w) => w.tierLabel, { style: 'muted' }),
        row('Hourly rate', (w) => fmtRate(w.incentiveRate), { boldCols: weeks.map((_, i) => i + 1) }),
        row('Core pay', (w) => `${fmtNum(w.corePaidHours)} h  ·  ${fmtMoney(w.coreEarnings)}`),
        row('Bonus pay', (w) => `${fmtNum(w.bonusHours)} h  ·  ${fmtMoney(w.bonusEarnings)}`),
      ];
  perfRows.push({ cells: ['Week total', ...weeks.map((w) => fmtMoney(w.weeklyEarnings))], style: 'total' });
  table(doc, cols, perfRows);

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
        const hit = weeks.filter((w) => w.tierIndex === i).map((w) => `Week ${w.weekNumber}`);
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

  // Adjustments detail
  if (v.adjustments?.length) {
    sectionTitle(doc, 'Deductions & additions detail');
    const ADD = new Set(['REIMBURSEMENT', 'OTHER_INCOME']);
    table(doc, [
      { header: 'Type', width: W * 0.24 },
      { header: 'Description', width: W * 0.46 },
      { header: 'Date', width: W * 0.13 },
      { header: 'Amount', width: W * 0.17, align: 'right' },
    ], v.adjustments.map((a) => ({
      cells: [
        a.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
        a.description || '—',
        shortDate(a.date),
        `${ADD.has(a.type) ? '+' : '–'}${fmtMoney(a.amount)}`,
      ],
      colors: [C.ink, C.text, C.muted, ADD.has(a.type) ? C.green : C.red],
      boldCols: [3],
    })));
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
        c && c.otherDeductions !== '0.00' ? `–${fmtMoney(c.otherDeductions)}` : '—',
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
  const total = (key, sign) => {
    const v = money(sum(calcs.map((c) => c[key])));
    return v === '0.00' ? '—' : `${sign}${fmtMoney(v)}`;
  };
  rows.push({
    cells: [
      'Total', '', '', '',
      total('gross', ''), total('lease', '–'), total('fares', '–'), total('otherDeductions', '–'), total('totalAdditions', '+'),
      total('net', ''), '',
    ],
    style: 'total',
  });
  table(doc, cols, rows, { fontSize: 8.4, rowPad: 4, totalBump: 0 });
  doc.fillColor(C.muted).font(F.reg).fontSize(7.5)
    .text('Wk 1 / Wk 2 = hours worked (trips below). Lease, Fares and Other are deductions; Added = reimbursements and other income.', L, doc.y + 2, { width: W });

  footers(doc, `Big Star Transit · VDP payment register · DIV ${division.divisionNumber} – ${division.name} · ${cycleText(cycle)} · Generated ${localDate(new Date(), division.timezone)}`);
  return {
    buffer: await toBuffer(doc),
    fileName: `VDP Register DIV ${division.divisionNumber} ${isoDate(cycle.cycleStart)} to ${isoDate(cycle.cycleEnd)}.pdf`,
  };
}

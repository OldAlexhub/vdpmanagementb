import ExcelJS from 'exceljs';
import Vdp from '../models/Vdp.js';
import Provider from '../models/Provider.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import { ADJUSTMENT_TYPES } from './calculationEngine.js';
import { isoDate, localDate } from './cycleService.js';
import { notFound } from './errors.js';

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export const approvalText = (v, tz) => {
  const a = v.providerApproval;
  const d = (x) => localDate(x, tz, 'short');
  if (v.status === 'PAID') return `Paid ${d(v.paidAt)}`;
  if (a?.method === 'PROVIDER') return `Provider approved ${d(a.at)}`;
  if (a?.method === 'AUTO') return `Auto-approved ${d(a.at)}`;
  if (v.status === 'APPROVED') return v.providerDeadline ? `Provider due ${d(new Date(v.providerDeadline.getTime() - 1))}` : 'Awaiting provider';
  if (v.status === 'DISPUTED') return 'Provider reported an issue';
  return '';
};

/**
 * One row per VDP in a cycle, shared by the Excel and PDF registers.
 * Approved/processed/paid rows come from their frozen snapshot.
 */
export async function loadRegister(cycleId) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const division = await Division.findById(cycle.divisionId);
  const vdps = await Vdp.find({ cycleId });
  const providers = new Map((await Provider.find({ divisionId: cycle.divisionId })).map((p) => [String(p._id), p]));
  const entries = vdps.map((v) => {
    const src = v.snapshot || {};
    const p = providers.get(String(v.providerId));
    return {
      vdp: v,
      status: v.status,
      provider: src.provider || { name: p?.name, providerNumber: p?.providerNumber, operatorName: p?.operatorName, routes: p?.routes },
      planName: src.plan?.name || v.settings?.planName || '',
      calc: src.calculation || v.calculation,
      adjustments: src.adjustments || v.adjustments,
      approval: approvalText(v, division.timezone),
    };
  }).sort((a, b) => String(a.provider.name).localeCompare(String(b.provider.name)));
  return { cycle, division, entries };
}

const MONEY = '#,##0.00;[Red]-#,##0.00';

export async function cycleWorkbook(cycleId) {
  const { cycle, division, entries } = await loadRegister(cycleId);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Big Star VDP';
  const ws = wb.addWorksheet('VDP Summary', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.addRow([`${division.divisionNumber} – ${division.name}`]).font = { bold: true, size: 14 };
  ws.addRow([`VDP cycle ${isoDate(cycle.cycleStart)} to ${isoDate(cycle.cycleEnd)} · payment date ${cycle.paymentDate ? isoDate(cycle.paymentDate) : '—'}`]);
  ws.addRow([]);
  const header = [
    'Provider', 'Provider #', 'Operator', 'Route(s)', 'Plan', 'Status',
    'W1 Trips', 'W1 Hours', 'W1 %', 'W1 Rate', 'W1 Core', 'W1 Bonus', 'W1 Total',
    'W2 Trips', 'W2 Hours', 'W2 %', 'W2 Rate', 'W2 Core', 'W2 Bonus', 'W2 Total',
    'Gross VDP', 'Lift Lease', 'Fares', 'Other Deductions', 'Fuel Overspend', 'Fuel Reimbursement', 'Reimbursements', 'Other Income', 'Net VDP',
    'Provider approval', 'Service Miles', 'Fuel MPG', 'Max Allowed Fuel', 'Actual Fuel Expense',
  ];
  const h = ws.addRow(header);
  h.font = { bold: true };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF6' } };

  const adjRows = [];
  entries.forEach((e) => {
    e.adjustments.forEach((a) => adjRows.push([
      e.provider.name, ADJUSTMENT_TYPES[a.type]?.label || a.type, ADJUSTMENT_TYPES[a.type]?.direction, num(a.amount?.toString()),
      a.description || '', a.date ? isoDate(a.date) : '', a.createdBy?.name || '',
    ]));
    const w = (i) => e.calc?.weeks?.[i] || {};
    const weekCols = (i) => [num(w(i).trips), num(w(i).actualHours), num(w(i).performancePercentage) / 100 || null,
      num(w(i).incentiveRate), num(w(i).coreEarnings), num(w(i).bonusEarnings), num(w(i).weeklyEarnings)];
    ws.addRow([
      e.provider.name, e.provider.providerNumber, e.provider.operatorName, (e.provider.routes || []).join(', '),
      e.planName, e.status,
      ...weekCols(0), ...weekCols(1),
      num(e.calc?.gross), num(e.calc?.lease), num(e.calc?.fares), num(e.calc?.otherDeductions), num(e.calc?.fuelOverspend),
      num(e.calc?.fuelReimbursement), num(e.calc?.reimbursements), num(e.calc?.otherIncome), num(e.calc?.net),
      e.approval,
      ...(e.calc?.fuelAllowance
        ? [num(e.calc.fuelAllowance.serviceMiles), num(e.calc.fuelAllowance.mpg), num(e.calc.fuelAllowance.maxAllowed), num(e.calc.fuelAllowance.actualExpense)]
        : []),
    ]);
  });

  const first = 5;
  const last = ws.rowCount;
  if (entries.length) {
    const total = ws.addRow(['Total']);
    total.font = { bold: true };
    for (let c = 21; c <= 29; c += 1) {
      const col = ws.getColumn(c).letter;
      total.getCell(c).value = { formula: `SUM(${col}${first}:${col}${last})` };
    }
  }
  [11, 12, 13, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 33, 34].forEach((c) => { ws.getColumn(c).numFmt = MONEY; });
  [10, 17].forEach((c) => { ws.getColumn(c).numFmt = '$0.00##'; });
  [9, 16].forEach((c) => { ws.getColumn(c).numFmt = '0.00%'; });
  ws.columns.forEach((col, i) => { col.width = i < 5 || i === 29 ? 24 : 12; });

  const adj = wb.addWorksheet('Adjustments');
  adj.addRow(['Provider', 'Type', 'Direction', 'Amount', 'Description', 'Date', 'Entered by']).font = { bold: true };
  adjRows.forEach((r) => adj.addRow(r));
  adj.getColumn(4).numFmt = MONEY;
  adj.columns.forEach((c) => { c.width = 20; });

  // Per-operator detail: each operator is measured against their own contract.
  const byOp = wb.addWorksheet('By operator');
  byOp.addRow(['Provider', 'Operator', 'Route(s)', 'W1 Trips', 'W1 Hours', 'W1 Contract', 'W1 %', 'W1 Rate', 'W1 Total',
    'W2 Trips', 'W2 Hours', 'W2 Contract', 'W2 %', 'W2 Rate', 'W2 Total', 'Earned', 'Lift Lease']).font = { bold: true };
  entries.forEach((e) => {
    for (const o of e.calc?.operators || []) {
      const wk = (i) => {
        const w = o.weeks[i] || {};
        return [num(w.trips), num(w.actualHours), num(w.contractedHours), num(w.performancePercentage) / 100 || null, num(w.incentiveRate), num(w.weeklyEarnings)];
      };
      byOp.addRow([e.provider.name, o.name || e.provider.operatorName, (o.routes || []).join(', '), ...wk(0), ...wk(1), num(o.earnings), num(o.lease)]);
    }
  });
  [9, 15, 16, 17].forEach((c) => { byOp.getColumn(c).numFmt = MONEY; });
  [8, 14].forEach((c) => { byOp.getColumn(c).numFmt = '$0.00##'; });
  [7, 13].forEach((c) => { byOp.getColumn(c).numFmt = '0.00%'; });
  byOp.columns.forEach((c, i) => { c.width = i < 3 ? 24 : 11; });

  const fileName = `VDP ${division.divisionNumber} ${isoDate(cycle.cycleStart)} to ${isoDate(cycle.cycleEnd)}.xlsx`;
  return { buffer: await wb.xlsx.writeBuffer(), fileName };
}

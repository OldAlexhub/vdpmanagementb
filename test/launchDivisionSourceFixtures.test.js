import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseDivisionSourceFile } from '../src/services/divisionSourceParser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = (...parts) => path.resolve(here, '..', '..', 'artifacts', 'VPDs', ...parts);
const cycle = {
  cycleStart: new Date('2026-09-07T00:00:00.000Z'),
  cycleEnd: new Date('2026-09-20T23:59:59.999Z'),
};

async function parse(parts, divisionNumber, datasetType) {
  const filePath = artifact(...parts);
  return parseDivisionSourceFile(await fs.readFile(filePath), path.basename(filePath), divisionNumber, datasetType, { cycle });
}

test('launch division parsers normalize the representative source artifacts', async (t) => {
  await t.test('DIV 5 RPR produces daily performance facts', async () => {
    const result = await parse(
      ['DIV5', 'VDP Automation', 'BIGSTAR.RPR DATA', 'BIGSTAR.RPR.0907202609132026.xlsx'],
      '5', 'DIV5_RPR',
    );
    assert.equal(result.adapterVersion, 'DIV5_V1');
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows.every((row) => row.date && row.route));
  });

  await t.test('DIV 6 Trapeze produces trip and mileage facts', async () => {
    const result = await parse(
      ['DIV6', 'VDP AUTOMATION', 'Trapeze Raw Data', 'Trapeze Raw Data_9.7.2026-9.13.2026.csv'],
      '6', 'DIV6_TRAPEZE',
    );
    assert.equal(result.adapterVersion, 'DIV6_V1');
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows.some((row) => Number(row.trips) > 0));
  });

  await t.test('DIV 7 productivity and hours produce facts and observed windows', async () => {
    const productivity = await parse(
      ['DIV7', 'VDP AUTOMATION', 'Daily Run Productivity', 'Daily Run Productivity - 09.07.2026 - 09.13.2026.xls'],
      '7', 'DIV7_DAILY_PRODUCTIVITY',
    );
    const hours = await parse(
      ['DIV7', 'VDP AUTOMATION', 'Hour Report', 'Driver Hour Report - 09.07.2026 - 09.13.2026.csv'],
      '7', 'DIV7_DRIVER_HOURS',
    );
    assert.equal(productivity.adapterVersion, 'DIV7_V1');
    assert.ok(productivity.rows.length > 0);
    assert.ok(hours.division10ManifestRows.length > 0);
    assert.ok(hours.division10ManifestRows.every((row) => row.actualEndMinutes > row.actualStartMinutes));
  });

  await t.test('DIV 8 duty produces performance facts and observed windows', async () => {
    const result = await parse(
      ['DIV8', 'VDP AUTOMATION', 'Duty Report', '2026-09-07_to_2026-09-13_DutyReportExport.csv'],
      '8', 'DIV8_DUTY',
    );
    assert.equal(result.adapterVersion, 'DIV8_V1');
    assert.ok(result.rows.length > 0);
    assert.ok(result.division10ManifestRows.length > 0);
  });

  await t.test('DIV 10 Coast report produces fuel-expense facts', async () => {
    const result = await parse(
      ['DIV10', 'VDP AUTOMATION', 'Coast Transactions', 'Coast Fuel Report - 08.24.26 - 09.6.26.csv'],
      '10', 'DIV10_COAST_FUEL',
    );
    assert.equal(result.adapterVersion, 'DIV10_V2');
    assert.ok(result.division10FuelRows.length > 0);
    assert.ok(result.division10FuelRows.every((row) => row.date && row.operatorName && Number(row.amount) > 0));
  });

  await t.test('DIV 11 shift report produces performance facts and observed windows', async () => {
    const result = await parse(
      ['DIV11', 'VDP AUTOMATION', 'Shift Hours and Mileage', '9.0 Shift Hours Mileage Report 9.7 - 9.13.xlsx'],
      '11', 'DIV11_SHIFT_HOURS',
    );
    assert.equal(result.adapterVersion, 'DIV11_V1');
    assert.ok(result.rows.length > 0);
    assert.ok(result.division10ManifestRows.length > 0);
  });
});

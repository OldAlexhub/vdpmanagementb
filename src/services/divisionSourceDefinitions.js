import { divisionNumberKey } from './divisionGroups.js';

const spreadsheet = ['.xlsx', '.xls', '.csv'];

const source = (definition) => ({
  handler: 'DIVISION_SOURCE',
  multiple: true,
  accept: spreadsheet,
  required: true,
  coverage: 'BOTH_WEEKS',
  stage: 'REQUIRED',
  ...definition,
});

// The finalized VDP workbook is the source of truth for each contract: trace
// its FilePath/query inputs backward, then use the recurring RAW DATA samples
// to prove the exact schema. Static rate tables, plan templates, operator
// deductions, and lift-lease configuration intentionally do not appear here.
const CONTRACTS = {
  5: [
    source({
      id: 'DIV5_BIG_EXPORT',
      title: 'Big Export data',
      hint: 'Upload both weekly BIGSTAR.EXPORT files.',
      cycleLocator: true,
      requiredCells: ['Trip Type', 'Date', 'Trip ID', 'Employee Name', 'Trip Miles', 'Trip Time Minutes'],
      dateHeaders: ['Date'],
    }),
    source({
      id: 'DIV5_RPR',
      title: 'Big Star RPR data',
      hint: 'Upload both weekly BIGSTAR.RPR productivity workbooks.',
      requiredCells: ['CLI', 'PCA', 'ESC', 'Trips', 'Service', 'Live', 'DH'],
      dateColumns: [0],
    }),
    source({
      id: 'DIV5_TICKETS',
      title: 'Tickets collected',
      hint: 'Upload the returned ticket workbook for each reporting partner and week.',
      stage: 'ADDITIONAL',
      requiredCells: ['Trip Type', 'PARTNER NAME', 'Date', 'Trip ID', 'Tickets Collected', 'Ticket Value'],
      dateHeaders: ['Date'],
    }),
  ],
  6: [
    source({
      id: 'DIV6_TRAPEZE',
      title: 'Trapeze raw data',
      hint: 'Upload both weekly Trapeze raw-data exports.',
      cycleLocator: true,
      requiredCells: ['ldate', 'evstrname', 'Driver Name', 'VehicleNumber', 'fareamount', 'Direct_Distance'],
      dateHeaders: ['ldate'],
    }),
    source({
      id: 'DIV6_RETURNED_TICKETS',
      title: 'Returned tickets',
      hint: 'Upload both weekly returned-ticket reconciliation files.',
      stage: 'ADDITIONAL',
      requiredCells: ['PARTNER NAME', 'DriverName', 'Date', 'Trips', 'Fare To Collect', '# Tickets Collected', 'Cash to be Deducted'],
      dateHeaders: ['Date'],
    }),
  ],
  7: [
    source({
      id: 'DIV7_DAILY_PRODUCTIVITY',
      title: 'Daily run productivity',
      hint: 'Upload both weekly Daily Run Productivity reports.',
      cycleLocator: true,
      requiredCells: ['Daily Run Productivity', 'Run', 'Trips', 'Source', 'Deadhead', 'Service', 'Revenue'],
      scanDateTextRows: 25,
    }),
    source({
      id: 'DIV7_DRIVER_HOURS',
      title: 'Driver hour report',
      hint: 'Upload both weekly Driver Hour Reports.',
      requiredCells: ['Driver Name', 'Provider', 'Date', 'Vehicle', 'Run', 'Pull out est', 'Pull out act', 'First PU est', 'Last DO act'],
      dateHeaders: ['Date'],
    }),
    source({
      id: 'DIV7_FARES',
      title: 'Fare summary reports',
      hint: 'Upload one Fare Summary Report for every date in the VDP period.',
      stage: 'ADDITIONAL',
      coverage: 'EVERY_DAY',
      requiredCells: ['Fare Summary', 'Run #', "Driver's Name", 'Vehicle', 'Cash'],
      allowCompactMonthDayFileName: true,
    }),
    source({
      id: 'DIV7_MANIFESTS',
      title: 'Driver run manifests',
      hint: 'Upload one By Driver Run Manifest for every date in the VDP period.',
      stage: 'ADDITIONAL',
      coverage: 'EVERY_DAY',
      requiredCells: ['Run Manifest', 'Trips', 'Fare Summary'],
      allowCompactMonthDayFileName: true,
    }),
    source({
      id: 'DIV7_MESSAGES',
      title: 'Message reports',
      hint: 'Upload both weekly Alerts Resolution reports.',
      stage: 'ADDITIONAL',
      requiredCells: ['Alerts Resolution'],
    }),
    source({
      id: 'DIV7_COAST_FUEL',
      title: 'Coast fuel transactions',
      hint: 'Only for providers whose plan reimburses Coast fuel transactions.',
      stage: 'ADDITIONAL',
      required: false,
      requiredCells: ['Date', 'User', 'Vehicle', 'Fuel Grade', 'Gallons', 'Cost Per Gallon'],
      dateHeaders: ['Date'],
    }),
    source({
      id: 'DIV7_LAKESIDE_FUEL',
      title: 'Lakeside fuel data',
      hint: 'Only for providers whose plan uses the Lakeside fuel workbook. Receipt images are reviewed separately.',
      stage: 'ADDITIONAL',
      required: false,
      accept: spreadsheet,
      requiredCells: ['Date', 'Vehicle #', 'Odometer', 'Gallons', 'Cost ($)', 'Driver ID'],
      dateHeaders: ['Date'],
    }),
  ],
  8: [
    source({
      id: 'DIV8_DUTY',
      title: 'Duty reports',
      hint: 'Upload both weekly DutyReportExport files.',
      cycleLocator: true,
      requiredCells: ['Driver Name', 'Duty ID', 'Duty Scheduled Start Time', 'Duty Actual Started Time', 'Duty Status', 'Total Revenue Hours'],
      dateHeaders: ['Duty Actual Started Time', 'Duty Scheduled Start Time'],
    }),
    source({
      id: 'DIV8_RIDERSHIP',
      title: 'Ridership reports',
      hint: 'Upload both weekly RidershipExport files.',
      requiredCells: ['Request ID', 'Trip Status', 'Pickup Arriving At', 'Driver Name', 'Duty ID', 'Fare Cost'],
      dateHeaders: ['Pickup Arriving At', 'Requested Pickup Time', 'Original Requested Pickup Time'],
      allowDatesOutsideCycle: true,
    }),
  ],
  10: [
    source({
      id: 'DIV10_MANIFESTS',
      title: 'Manifest exports',
      hint: 'Upload one MANIFESTEXPORT CSV for every date in the VDP period.',
      cycleLocator: true,
      coverage: 'EVERY_DAY',
      accept: ['.csv'],
      requiredCells: ['EVSTRNAME', 'ACT', 'STATUS', 'Arrived*', 'Departed*', 'LASTNAME', 'FIRSTNAME', 'VEH'],
      scanDateTextRows: 5,
      allowDateFromFileName: true,
    }),
    source({
      id: 'DIV10_JASPER_TRIPS',
      title: 'Jasper trip reports',
      hint: 'Upload every Jasper trip report that overlaps this VDP period.',
      coverage: 'CYCLE_OVERLAP',
      allowDatesOutsideCycle: true,
      requiredCells: ['Booking ID', 'Ride Date', 'Provider', 'Route', 'Trip Status', 'PU', 'Fare Type', 'Operator Name'],
      dateHeaders: ['Ride Date'],
    }),
    source({
      id: 'DIV10_TRAPEZE_HOURS',
      title: 'Trapeze hours / productivity',
      hint: 'Upload every Big Star Productivity Report that overlaps this VDP period.',
      coverage: 'CYCLE_OVERLAP',
      allowDatesOutsideCycle: true,
      requiredCells: ['CLI', 'PCA', 'ESC', 'Trips', 'Service', 'Live', 'DH'],
      dateColumns: [0],
    }),
    source({
      id: 'DIV10_COAST_FUEL',
      title: 'Coast fuel transactions',
      hint: 'Only for providers whose plan reimburses Coast fuel transactions.',
      stage: 'ADDITIONAL',
      required: false,
      requiredCells: ['Date', 'User', 'Vehicle', 'Amount', 'Fuel Grade', 'Gallons', 'Cost Per Gallon'],
      dateHeaders: ['Date'],
      allowDatesOutsideCycle: true,
    }),
  ],
  11: [
    source({
      id: 'DIV11_RIDES',
      title: 'Ride exports',
      hint: 'Upload both weekly Ride Export workbooks.',
      cycleLocator: true,
      requiredCells: ['Program', 'Agenda Day', 'Ride ID', 'Ride Status', 'Pickup Time', 'Driver Arrived'],
      dateHeaders: ['Agenda Day'],
    }),
    source({
      id: 'DIV11_SHIFT_HOURS',
      title: 'Shift hours and mileage',
      hint: 'Upload both weekly Shift Hours Mileage Reports.',
      requiredCells: ['Program', 'Date', 'Driver', 'Shift ID', 'Shift', 'Provider', 'Total Scheduled Hours', 'Total Online Hours', 'Vehicle Revenue Hours'],
      dateHeaders: ['Date'],
    }),
  ],
};

const TARGET_WORKBOOKS = {
  2: ['VDP_DIV2 UPDATED TEMPLATE.xlsm'],
  3: ['VDP_DIV3 UPDATED TEMPLATE.xlsm'],
  5: ['VDP_DIV5 UPDATED TEMPLATE.xlsm'],
  6: ['VDP_DIV6 UPDATED TEMPLATE.xlsm'],
  7: ['VDP_DIV7 UPDATED TEMPLATE.xlsm', 'VDP_DIV7 UPDATED TEMPLATE TUI.xlsm'],
  8: ['VDP_DIV8 UPDATED TEMPLATE TUI.xlsm'],
  10: ['VDP_DIV10 UPDATED TEMPLATE.xlsm'],
  11: ['VDP_DIV11 UPDATED TEMPLATE.xlsm'],
  12: ['VDP_DIV12 UPDATED TEMPLATE.xlsm'],
};

export const contractForDivisionNumber = (divisionNumber) => CONTRACTS[divisionNumberKey(divisionNumber)] || [];

export const definitionForDataset = (divisionNumber, datasetType) => (
  contractForDivisionNumber(divisionNumber).find((item) => item.id === String(datasetType || '').trim()) || null
);

export const publicSourceDefinition = (definition) => definition && ({
  id: definition.id,
  title: definition.title,
  hint: definition.hint,
  stage: definition.stage,
  required: definition.required,
  multiple: definition.multiple,
  accept: definition.accept,
  coverage: definition.coverage,
  cycleLocator: Boolean(definition.cycleLocator),
});

export const publicContractForDivision = (division) => {
  const divisionNumber = divisionNumberKey(division?.divisionNumber);
  const targetWorkbooks = TARGET_WORKBOOKS[divisionNumber] || [];
  return {
    divisionNumber,
    configured: contractForDivisionNumber(divisionNumber).length > 0,
    targetWorkbook: targetWorkbooks[0] || null,
    targetWorkbooks,
    datasets: contractForDivisionNumber(divisionNumber).map(publicSourceDefinition),
  };
};


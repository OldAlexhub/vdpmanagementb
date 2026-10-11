// Audited starter configurations from artifacts/VPDs/VDP Plans.
// Templates are never assigned or calculated directly. The create-plan screen
// copies one into an ordinary editable/versioned plan.

const standard = (overrides) => ({
  calculationType: 'STANDARD',
  paymentType: 'HOURLY',
  rateStructureType: 'SIMPLE',
  basePay: '',
  contractedHours: '',
  contractedHoursMode: 'PLAN_DEFAULT',
  incentiveEnabled: false,
  incentiveTiers: [],
  attainmentHourMetric: 'SAME_AS_PAID',
  attainmentHourColumn: '',
  attainmentScope: 'OPERATOR',
  attainmentPercentageCap: '',
  performanceHourMetric: 'TOTAL_HOURS',
  performanceHourColumn: '',
  bonusEnabled: false,
  bonusRate: '',
  bonusBasis: 'HOURS_ABOVE_CONTRACT',
  bonusQualificationMetric: 'PAID_HOURS',
  bonusQualificationPercentage: '100',
  contractedDays: '',
  bonusRequiresContractedDays: false,
  standbyGuaranteeEnabled: false,
  standbyRate: '',
  fuelMethod: 'NONE',
  fuelReimbursementRate: '',
  fuelMpg: '',
  fuelPriceThreshold: '',
  rateCards: [],
  effectiveFrom: '',
  effectiveTo: '',
  notes: '',
  ...overrides,
});

// The Division 3 Accounting rate workbook has two revenue-hour schedules.
// Core revenue is 80% of the full rate; 94/96/98 fulfillment adds
// 5/10/20% of the full rate. These are the resulting all-in hourly tiers.
const div3Dart = (revenueRate = '32.00', notes = '') => {
  const thirtyFour = revenueRate === '34.00';
  return standard({
    basePay: thirtyFour ? '27.20' : '25.60',
    contractedHoursMode: 'OPERATOR_PROFILE',
    incentiveEnabled: true,
    attainmentHourMetric: 'OTHER',
    attainmentHourColumn: 'Incentive Hours',
    attainmentScope: 'PROVIDER',
    attainmentPercentageCap: '100',
    incentiveTiers: thirtyFour ? [
      { minimumPercentage: '0', maximumPercentage: '93.99', rate: '27.20' },
      { minimumPercentage: '94', maximumPercentage: '95.99', rate: '28.90' },
      { minimumPercentage: '96', maximumPercentage: '97.99', rate: '30.60' },
      { minimumPercentage: '98', maximumPercentage: '', rate: '34.00' },
    ] : [
      { minimumPercentage: '0', maximumPercentage: '93.99', rate: '25.60' },
      { minimumPercentage: '94', maximumPercentage: '95.99', rate: '27.20' },
      { minimumPercentage: '96', maximumPercentage: '97.99', rate: '28.80' },
      { minimumPercentage: '98', maximumPercentage: '', rate: '32.00' },
    ],
    notes,
  });
};

const uber = (overrides = {}) => ({
  calculationType: 'UBER',
  paymentType: 'HOURLY',
  effectiveFrom: '',
  effectiveTo: '',
  notes: '',
  uberConfig: {
    coreRatePct: '0.65',
    approvedExtraHours: '0',
    minimumFulfillmentForIncentives: '0.94',
    belowThresholdBehavior: 'FARES_ONLY',
    rateStructureType: 'FLAT',
    rateStructureScope: 'PAY_UNIT',
    rateBandOverflowBehavior: 'ERROR',
    hourlyRateBands: [],
    contractHoursIncentiveTiers: [
      { minimum: '0.94', rate: '0.05' },
      { minimum: '0.96', rate: '0.10' },
      { minimum: '0.98', rate: '0.20' },
    ],
    acceptanceIncentiveTiers: [{ minimum: '0.92', rate: '0.05' }, { minimum: '0.95', rate: '0.10' }],
    cancellationIncentiveTiers: [{ maximum: '0.04', rate: '0.10' }, { maximum: '0.05', rate: '0.05' }],
    utilizationEnabled: true,
    utilizationTarget: '0.70',
    utilizationIncentivePct: '0.05',
    coreHoursRuleType: 'PERCENTAGE',
    coreHoursRequirement: '0.60',
    incentiveScope: 'PAY_UNIT',
    coreHoursFailureBehavior: 'STATUS_ONLY',
    ...(overrides.uberConfig || {}),
  },
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'uberConfig')),
});

const cardComponent = (name, basis, rate, extra = {}) => ({ name, basis, rate, dayType: 'ANY', ...extra });

const distanceCard = (name, minimumPercentage, maximumPercentage, shortRate, mediumRate, excessRate) => ({
  name,
  minimumPercentage,
  maximumPercentage,
  components: [
    cardComponent('Trips 0-5 miles', 'TRIPS', shortRate, { minimumDistance: '0', maximumDistance: '5' }),
    cardComponent('Trips over 5 through 8 miles', 'TRIPS', mediumRate, { minimumDistance: '5.0001', maximumDistance: '8' }),
    cardComponent('Base for trips over 8 miles', 'TRIPS', mediumRate, { minimumDistance: '8.0001' }),
    cardComponent('Miles over 8', 'EXCESS_MILES', excessRate, { minimumDistance: '8.0001', includedMiles: '8' }),
  ],
});

const templates = [
  {
    id: 'div2-uber-wav', divisionNumber: '2', name: 'DIV 2 Uber WAV', sourceDocument: 'DIV 2.pdf',
    description: 'Chicago WAV: provider-level hourly bands, with the first 70 hours per pay unit at $31.45 and the next 20 at $41.40; Uber fulfillment, acceptance/cancellation and utilization incentives.',
    version: uber({ notes: 'Documented weekly contract is 90 hours per vehicle. Configure contracted hours on each operator profile.', uberConfig: {
      rateStructureType: 'HOURLY_BANDS', hourlyRateBands: [
        { fromHour: '0', toHour: '70', hourlyRate: '31.45' },
        { fromHour: '70', toHour: '90', hourlyRate: '41.40' },
      ],
      rateStructureScope: 'PROVIDER', rateBandOverflowBehavior: 'FIRST_BAND',
      incentiveScope: 'PROVIDER',
    } }),
  },
  {
    id: 'div2-uber-wav-qtell', divisionNumber: '2', name: 'DIV 2 Uber WAV — Q-Tell rates', sourceDocument: 'DIV 2 Partner Rates.xlsx',
    description: 'Q-Tell operational rate variant: first 70 provider hours at $31.50 and the next 20 at $41.50, with the same Division 2 Uber incentives.',
    version: uber({ notes: 'Use only for the Q-Tell rate assignment. Configure contracted hours on each operator profile.', uberConfig: {
      rateStructureType: 'HOURLY_BANDS', hourlyRateBands: [
        { fromHour: '0', toHour: '70', hourlyRate: '31.50' },
        { fromHour: '70', toHour: '90', hourlyRate: '41.50' },
      ],
      rateStructureScope: 'PROVIDER', rateBandOverflowBehavior: 'FIRST_BAND',
      incentiveScope: 'PROVIDER',
    } }),
  },
  {
    id: 'div3-dart', divisionNumber: '3', name: 'DIV 3 DART MMS — $32 revenue rate', sourceDocument: 'DIV3 Partner Rates.xlsx',
    description: 'ADA $32 revenue-hour schedule: $25.60 core plus 5/10/20% top-up tiers, provider-wide fulfillment capped at 100%.',
    version: div3Dart('32.00', 'Enter each operator’s weekly contracted hours. Assign the $34 preset only to partners listed at $34 in the Accounting rate workbook.'),
  },
  {
    id: 'div3-dart-34', divisionNumber: '3', name: 'DIV 3 DART MMS — $34 revenue rate', sourceDocument: 'DIV3 Partner Rates.xlsx',
    description: 'ADA $34 revenue-hour schedule: $27.20 core plus 5/10/20% top-up tiers, provider-wide fulfillment capped at 100%.',
    version: div3Dart('34.00', 'Use only for partners listed at the $34 revenue-hour rate in the Accounting rate workbook.'),
  },
  {
    id: 'div3-golink-32', divisionNumber: '3GL', name: 'DIV 3 DART GLINK — $32 revenue rate', sourceDocument: 'DIV3 Partner Rates.xlsx',
    description: 'GoLink $32 revenue-hour schedule with provider-wide fulfillment capped at 100%.',
    version: div3Dart('32.00', 'GoLink schedule for partners listed at the $32 revenue-hour rate in the Accounting rate workbook.'),
  },
  {
    id: 'div3-golink-34', divisionNumber: '3GL', name: 'DIV 3 DART GLINK — $34 revenue rate', sourceDocument: 'DIV3 Partner Rates.xlsx',
    description: 'GoLink $34 revenue-hour schedule with provider-wide fulfillment capped at 100%.',
    version: div3Dart('34.00', 'GoLink schedule for partners listed at the $34 revenue-hour rate in the Accounting rate workbook.'),
  },
  {
    id: 'div3-dart-bts', divisionNumber: '3', name: 'DIV 3 DART MMS — BTS', sourceDocument: 'DIV 3 BTS.pdf',
    description: 'BTS copy of the DART ADA/GoLink plan with separate provider-wide attainment by service.',
    version: div3Dart('34.00', 'Enter BTS operator contracted hours so ADA and GoLink service totals match the Accounting provider rates.'),
  },
  {
    id: 'div3-dart-melinio', divisionNumber: '3', name: 'DIV 3 DART MMS — Melinio', sourceDocument: 'DIV 3 MELINIO.pdf',
    description: 'Melinio copy of the DART ADA/GoLink plan with separate provider-wide attainment by service.',
    version: div3Dart('34.00', 'Enter Melinio operator contracted hours so ADA and GoLink service totals match the Accounting provider rates.'),
  },
  {
    id: 'div3-uber-d2d', divisionNumber: '3', name: 'DIV 3 Uber D2D', sourceDocument: 'DIV 3 UBER.pdf',
    description: 'Dallas D2D: 80% core, 90/96/98 fulfillment tiers, acceptance/cancellation incentive, no utilization incentive.',
    version: uber({ notes: 'Document example uses 190 weekly hours over two vehicles and a $28.50 operator base rate.', uberConfig: {
      coreRatePct: '0.80', minimumFulfillmentForIncentives: '0.90', belowThresholdBehavior: 'CORE_ONLY',
      contractHoursIncentiveTiers: [{ minimum: '0.90', rate: '0.05' }, { minimum: '0.96', rate: '0.10' }, { minimum: '0.98', rate: '0.15' }],
      acceptanceIncentiveTiers: [{ minimum: '0.95', rate: '0.05' }], cancellationIncentiveTiers: [{ maximum: '0.04', rate: '0.05' }],
      utilizationEnabled: false, coreHoursRuleType: 'PERCENTAGE', coreHoursRequirement: '1.00', incentiveScope: 'PROVIDER',
    } }),
  },
  {
    id: 'div5-service-rate-card', divisionNumber: '5', name: 'DIV 5 Service Rate Card', sourceDocument: 'DIV 5.pdf',
    description: 'CCCTA/LAVTA hourly vehicle rates, weekend differential, One Seat load/mile pricing, and fuel-price surcharge.',
    version: standard({ paymentType: 'HOURLY', rateStructureType: 'RATE_CARD', fuelMethod: 'PRICE_THRESHOLD_SURCHARGE', fuelMpg: '19', fuelPriceThreshold: '4.60', rateCards: [{
      name: 'Published service rates', minimumPercentage: '0', maximumPercentage: '', components: [
        cardComponent('CCCTA Link wheelchair hours', 'HOURS', '32.50', { serviceType: 'CCCTA Link', vehicleType: 'Wheelchair' }),
        cardComponent('CCCTA Link sedan hours', 'HOURS', '29.00', { serviceType: 'CCCTA Link', vehicleType: 'Sedan' }),
        cardComponent('LAVTA Wheels wheelchair hours', 'HOURS', '35.00', { serviceType: 'LAVTA Wheels', vehicleType: 'Wheelchair' }),
        cardComponent('LAVTA Wheels sedan hours', 'HOURS', '29.00', { serviceType: 'LAVTA Wheels', vehicleType: 'Sedan' }),
        cardComponent('Weekend differential', 'HOURS', '2.00', { dayType: 'WEEKEND' }),
        cardComponent('One Seat wheelchair load', 'TRIPS', '6.50', { serviceType: 'One Seat', vehicleType: 'Wheelchair' }),
        cardComponent('One Seat wheelchair miles', 'MILES', '2.00', { serviceType: 'One Seat', vehicleType: 'Wheelchair' }),
        cardComponent('One Seat sedan load', 'TRIPS', '5.00', { serviceType: 'One Seat', vehicleType: 'Sedan' }),
        cardComponent('One Seat sedan miles', 'MILES', '1.75', { serviceType: 'One Seat', vehicleType: 'Sedan' }),
      ],
    }], notes: 'Default MPG is sedan (19). Supply the applicable line/day MPG for minivan 17, MiniWAV 12, or BIGWAV 7. Shared One Seat miles must be supplied only once.' }),
  },
  {
    id: 'div5-aarons-rate-card', divisionNumber: '5', name: 'DIV 5 — Aarons rate card', sourceDocument: 'Partner Rates.xlsx',
    description: 'Aarons operational CCCTA/LAVTA weekday and weekend rates, plus One Seat load and mileage rates.',
    version: standard({ paymentType: 'HOURLY', rateStructureType: 'RATE_CARD', fuelMethod: 'PRICE_THRESHOLD_SURCHARGE', fuelMpg: '19', fuelPriceThreshold: '4.60', rateCards: [{
      name: 'Aarons partner rates', minimumPercentage: '0', maximumPercentage: '', components: [
        cardComponent('CCCTA WAV weekday hours', 'HOURS', '32.50', { serviceType: 'CCCTA', vehicleType: 'WAV', dayType: 'WEEKDAY' }),
        cardComponent('CCCTA WAV weekend hours', 'HOURS', '35.00', { serviceType: 'CCCTA', vehicleType: 'WAV', dayType: 'WEEKEND' }),
        cardComponent('CCCTA sedan weekday hours', 'HOURS', '29.00', { serviceType: 'CCCTA', vehicleType: 'Sedan', dayType: 'WEEKDAY' }),
        cardComponent('CCCTA sedan weekend hours', 'HOURS', '29.00', { serviceType: 'CCCTA', vehicleType: 'Sedan', dayType: 'WEEKEND' }),
        cardComponent('LAVTA WAV weekday hours', 'HOURS', '34.50', { serviceType: 'LAVTA', vehicleType: 'WAV', dayType: 'WEEKDAY' }),
        cardComponent('LAVTA WAV weekend hours', 'HOURS', '37.00', { serviceType: 'LAVTA', vehicleType: 'WAV', dayType: 'WEEKEND' }),
        cardComponent('LAVTA sedan weekday hours', 'HOURS', '31.00', { serviceType: 'LAVTA', vehicleType: 'Sedan', dayType: 'WEEKDAY' }),
        cardComponent('LAVTA sedan weekend hours', 'HOURS', '31.00', { serviceType: 'LAVTA', vehicleType: 'Sedan', dayType: 'WEEKEND' }),
        cardComponent('One Seat WAV load', 'TRIPS', '6.50', { serviceType: 'One Seat', vehicleType: 'WAV' }),
        cardComponent('One Seat WAV miles', 'MILES', '2.00', { serviceType: 'One Seat', vehicleType: 'WAV' }),
        cardComponent('One Seat sedan load', 'TRIPS', '5.00', { serviceType: 'One Seat', vehicleType: 'Sedan' }),
        cardComponent('One Seat sedan miles', 'MILES', '1.75', { serviceType: 'One Seat', vehicleType: 'Sedan' }),
      ],
    }], notes: 'Use only for Aarons Transportation. Shared One Seat miles must be supplied once.' }),
  },
  {
    id: 'div5-express-rate-card', divisionNumber: '5', name: 'DIV 5 — Express rate card', sourceDocument: 'Partner Rates.xlsx',
    description: 'Express operational $36.77 WAV and $42.02 big-van hourly rates across CCCTA/LAVTA, plus One Seat WAV pricing.',
    version: standard({ paymentType: 'HOURLY', rateStructureType: 'RATE_CARD', fuelMethod: 'PRICE_THRESHOLD_SURCHARGE', fuelMpg: '19', fuelPriceThreshold: '4.60', rateCards: [{
      name: 'Express partner rates', minimumPercentage: '0', maximumPercentage: '', components: [
        cardComponent('CCCTA WAV hours', 'HOURS', '36.77', { serviceType: 'CCCTA', vehicleType: 'WAV' }),
        cardComponent('CCCTA big-van hours', 'HOURS', '42.02', { serviceType: 'CCCTA', vehicleType: 'BIGVAN' }),
        cardComponent('LAVTA WAV hours', 'HOURS', '36.77', { serviceType: 'LAVTA', vehicleType: 'WAV' }),
        cardComponent('LAVTA big-van hours', 'HOURS', '42.02', { serviceType: 'LAVTA', vehicleType: 'BIGVAN' }),
        cardComponent('One Seat WAV load', 'TRIPS', '6.50', { serviceType: 'One Seat', vehicleType: 'WAV' }),
        cardComponent('One Seat WAV miles', 'MILES', '2.00', { serviceType: 'One Seat', vehicleType: 'WAV' }),
      ],
    }], notes: 'Use only for Express Transportation Services. Weekday and weekend hourly rates are identical.' }),
  },
  {
    id: 'div5-tri-valley-rate-card', divisionNumber: '5', name: 'DIV 5 — Tri Valley rate card', sourceDocument: 'Partner Rates.xlsx',
    description: 'Tri Valley operational $40 hourly rate for WAV and sedan service across CCCTA/LAVTA, plus One Seat WAV pricing.',
    version: standard({ paymentType: 'HOURLY', rateStructureType: 'RATE_CARD', fuelMethod: 'PRICE_THRESHOLD_SURCHARGE', fuelMpg: '19', fuelPriceThreshold: '4.60', rateCards: [{
      name: 'Tri Valley partner rates', minimumPercentage: '0', maximumPercentage: '', components: [
        cardComponent('CCCTA WAV hours', 'HOURS', '40.00', { serviceType: 'CCCTA', vehicleType: 'WAV' }),
        cardComponent('CCCTA sedan hours', 'HOURS', '40.00', { serviceType: 'CCCTA', vehicleType: 'Sedan' }),
        cardComponent('LAVTA WAV hours', 'HOURS', '40.00', { serviceType: 'LAVTA', vehicleType: 'WAV' }),
        cardComponent('LAVTA sedan hours', 'HOURS', '40.00', { serviceType: 'LAVTA', vehicleType: 'Sedan' }),
        cardComponent('One Seat WAV load', 'TRIPS', '6.50', { serviceType: 'One Seat', vehicleType: 'WAV' }),
        cardComponent('One Seat WAV miles', 'MILES', '2.00', { serviceType: 'One Seat', vehicleType: 'WAV' }),
      ],
    }], notes: 'Use only for Tri Valley Transportation. Weekday and weekend hourly rates are identical.' }),
  },
  {
    id: 'div6-door-to-door', divisionNumber: '6', name: 'DIV 6 Door-to-Door', sourceDocument: 'DIV 6.pdf',
    description: '$22 per one-way trip plus $2 fuel reimbursement per trip.',
    version: standard({ paymentType: 'PER_TRIP', basePay: '22.00', fuelMethod: 'PER_TRIP', fuelReimbursementRate: '2.00' }),
  },
  {
    id: 'div6-door-to-door-125-fuel', divisionNumber: '6', name: 'DIV 6 Door-to-Door — $1.25 fuel', sourceDocument: 'Partner Rates DIV 6.xlsx',
    description: '$22 per one-way trip plus the $1.25 fuel-per-trip operational partner variant.',
    version: standard({ paymentType: 'PER_TRIP', basePay: '22.00', fuelMethod: 'PER_TRIP', fuelReimbursementRate: '1.25', notes: 'Use for partners assigned the $1.25 fuel-per-trip rate in the Division 6 partner workbook.' }),
  },
  {
    id: 'div7-xpress', divisionNumber: '7', name: 'DIV 7 Xpress / DDOT MetroLift', sourceDocument: 'DIV 7 - Xpress.pdf',
    description: '$50 per revenue hour, standby guarantee, and reimbursement of verified actual fuel cost.',
    version: standard({ basePay: '50.00', contractedHoursMode: 'OPERATOR_PROFILE', performanceHourMetric: 'REVENUE_HOURS', standbyGuaranteeEnabled: true, fuelMethod: 'ACTUAL_EXPENSE_REIMBURSEMENT' }),
  },
  {
    id: 'div7-lakeside', divisionNumber: '7', name: 'DIV 7 Lakeside', sourceDocument: 'DIV 7- LAKESIDE.pdf',
    description: '$48.41 per revenue hour, standby guarantee, and reimbursement of verified actual fuel cost.',
    version: standard({ basePay: '48.41', contractedHoursMode: 'OPERATOR_PROFILE', performanceHourMetric: 'REVENUE_HOURS', standbyGuaranteeEnabled: true, fuelMethod: 'ACTUAL_EXPENSE_REIMBURSEMENT', notes: 'Enter the provider-specific weekly contracted vehicle hours.' }),
  },
  {
    id: 'div7-standard', divisionNumber: '7', name: 'DIV 7 Standard Incentive', sourceDocument: 'DIV 7.pdf',
    description: 'Provider-specific weekly hours, incentive-window attainment, hourly top-up tiers, bonus hours and standby guarantee.',
    version: standard({ basePay: '24.34', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', bonusEnabled: true, bonusRate: '32.94', standbyGuaranteeEnabled: true, incentiveTiers: [
      { minimumPercentage: '0', maximumPercentage: '79.99', rate: '24.34' }, { minimumPercentage: '80', maximumPercentage: '86.99', rate: '25.77' },
      { minimumPercentage: '87', maximumPercentage: '94.99', rate: '26.63' }, { minimumPercentage: '95', maximumPercentage: '97.99', rate: '27.78' },
      { minimumPercentage: '98', maximumPercentage: '', rate: '28.64' },
    ], notes: 'Enter the operator/provider-specific weekly hours. Incentive window: Monday-Friday, 03:45-15:00.' }),
  },
  {
    id: 'div7-legacy-hourly', divisionNumber: '7', name: 'DIV 7 Operational Core / Bonus', sourceDocument: 'Div7 Partner Rate.xlsx',
    description: 'Operational partner schedule with $27.81 core hours and $38.11 hours above the provider-specific weekly contract.',
    version: standard({ basePay: '27.81', contractedHoursMode: 'OPERATOR_PROFILE', bonusEnabled: true, bonusRate: '38.11', notes: 'Use for the ordinary partners listed on the Division 7 operational partner-rate sheet; Lakeside and Xpress retain their separate presets.' }),
  },
  {
    id: 'div8-standard', divisionNumber: '8', name: 'DIV 8 Standard Incentive', sourceDocument: 'DIV 8.pdf',
    description: 'Provider-specific weekly hours, incentive-window attainment, hourly top-up tiers, bonus hours and standby guarantee.',
    version: standard({ basePay: '25.93', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', bonusEnabled: true, bonusRate: '33.55', standbyGuaranteeEnabled: true, incentiveTiers: [
      { minimumPercentage: '0', maximumPercentage: '79.99', rate: '25.93' }, { minimumPercentage: '80', maximumPercentage: '86.99', rate: '27.46' },
      { minimumPercentage: '87', maximumPercentage: '94.99', rate: '28.37' }, { minimumPercentage: '95', maximumPercentage: '97.99', rate: '29.59' },
      { minimumPercentage: '98', maximumPercentage: '', rate: '30.50' },
    ], notes: 'Enter the operator/provider-specific weekly hours. Incentive window: Monday-Friday, 03:45-12:45.' }),
  },
  {
    id: 'div8-no-bonus', divisionNumber: '8', name: 'DIV 8 Incentive — no bonus-hours rate', sourceDocument: 'Div8 Partner Rates.xlsx',
    description: 'Division 8 incentive tiers with no above-contract bonus, matching the exceptional zero-bonus partner row.',
    version: standard({ basePay: '25.93', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', bonusEnabled: false, standbyGuaranteeEnabled: true, incentiveTiers: [
      { minimumPercentage: '0', maximumPercentage: '79.99', rate: '25.93' }, { minimumPercentage: '80', maximumPercentage: '86.99', rate: '27.46' },
      { minimumPercentage: '87', maximumPercentage: '94.99', rate: '28.37' }, { minimumPercentage: '95', maximumPercentage: '97.99', rate: '29.59' },
      { minimumPercentage: '98', maximumPercentage: '', rate: '30.50' },
    ], notes: 'Use only for the partner assigned a zero bonus-hours rate in Div8 Partner Rates.xlsx.' }),
  },
  {
    id: 'div10-day', divisionNumber: '10', name: 'DIV 10 Day Service', sourceDocument: 'DIV 10 DayService.pdf',
    description: 'Per-trip core/top-up tiers, sixth-day trip bonus, separate incentive hours and standby guarantee.',
    version: standard({ paymentType: 'PER_TRIP', basePay: '20.10', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', bonusEnabled: true, bonusRate: '25.99', bonusBasis: 'SIXTH_DAY_TRIPS', contractedDays: '5', bonusRequiresContractedDays: true, standbyGuaranteeEnabled: true, incentiveTiers: [
      { minimumPercentage: '0', maximumPercentage: '79.99', rate: '20.10' }, { minimumPercentage: '80', maximumPercentage: '80', rate: '22.77' },
      { minimumPercentage: '80.01', maximumPercentage: '90', rate: '23.51' }, { minimumPercentage: '90.01', maximumPercentage: '97.99', rate: '24.13' },
      { minimumPercentage: '98', maximumPercentage: '', rate: '24.75' },
    ], notes: 'Enter the provider-specific contracted weekly hours. Qualifying sixth-day trips are identified from the dated performance rows and paid at $25.99 instead of the ordinary trip rate.' }),
  },
  {
    id: 'div10-day-operational-2150', divisionNumber: '10', name: 'DIV 10 Day Service — $21.50 operational', sourceDocument: 'VDP_DIV10 UPDATED TEMPLATE.xlsm',
    description: 'Operational accounting-workbook schedule: $21.50 per completed trip with the 19-MPG service-mile fuel allowance.',
    version: standard({ paymentType: 'PER_TRIP', basePay: '21.50', fuelMethod: 'SERVICE_MILE_ALLOWANCE', fuelMpg: '19', notes: 'Use for the regular day-service partners calculated at $21.50 per trip in the updated accounting template.' }),
  },
  {
    id: 'div10-night', divisionNumber: '10', name: 'DIV 10 Night Service', sourceDocument: 'DIV 10 NightService.pdf',
    description: 'Hourly core/top-up tiers, independent above-contract bonus, separate incentive hours and standby guarantee.',
    version: standard({ basePay: '25.97', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', bonusEnabled: true, bonusRate: '30.81', standbyGuaranteeEnabled: true, incentiveTiers: [
      { minimumPercentage: '0', maximumPercentage: '79.99', rate: '25.97' }, { minimumPercentage: '80', maximumPercentage: '80', rate: '27.00' },
      { minimumPercentage: '80.01', maximumPercentage: '90', rate: '27.88' }, { minimumPercentage: '90.01', maximumPercentage: '97.99', rate: '28.61' },
      { minimumPercentage: '98', maximumPercentage: '', rate: '29.35' },
    ], notes: 'Enter the provider-specific contracted weekly hours.' }),
  },
  {
    id: 'div10-night-operational', divisionNumber: '10', name: 'DIV 10 Night Service — operational rates', sourceDocument: 'DIV10 Partner Rate.xlsx',
    description: 'Operational workbook tiers at 80/87/95/100%, with a $25.97 core rate and $34.62 above-contract bonus rate.',
    version: standard({ basePay: '25.97', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', bonusEnabled: true, bonusRate: '34.62', incentiveTiers: [
      { minimumPercentage: '0', maximumPercentage: '79.99', rate: '25.97' }, { minimumPercentage: '80', maximumPercentage: '86.99', rate: '26.5472' },
      { minimumPercentage: '87', maximumPercentage: '94.99', rate: '27.4128' }, { minimumPercentage: '95', maximumPercentage: '99.99', rate: '28.1342' },
      { minimumPercentage: '100', maximumPercentage: '', rate: '28.8556' },
    ], notes: 'This preset preserves the operational spreadsheet rates separately from the signed Division 10 Night Service schedule.' }),
  },
  {
    id: 'div10-uber', divisionNumber: '10', name: 'DIV 10 Uber', sourceDocument: 'DIV 10 UBER.pdf',
    description: 'Uber: 65% core, 90/96/98 fulfillment tiers, acceptance/cancellation and utilization incentives, continuous coverage.',
    version: uber({ notes: 'Document example: one unit, 36 weekly contracted hours, $32.50 operator rate, 24/7 coverage.', uberConfig: {
      minimumFulfillmentForIncentives: '0.90',
      contractHoursIncentiveTiers: [{ minimum: '0.90', rate: '0.05' }, { minimum: '0.96', rate: '0.10' }, { minimum: '0.98', rate: '0.20' }],
      coreHoursRuleType: 'CONTINUOUS_COVERAGE', incentiveScope: 'PROVIDER',
    } }),
  },
  {
    id: 'div11-standard', divisionNumber: '11', name: 'DIV 11 Standard Incentive', sourceDocument: 'DIV 11.pdf',
    description: 'Provider-specific weekly hours, incentive-window top-up, bonus gated by full incentive hours, and standby guarantee.',
    version: standard({ basePay: '23.50', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', bonusEnabled: true, bonusRate: '33.00', bonusQualificationMetric: 'ATTAINMENT_HOURS', bonusQualificationPercentage: '100', standbyGuaranteeEnabled: true, incentiveTiers: [
      { minimumPercentage: '0', maximumPercentage: '79.99', rate: '23.50' }, { minimumPercentage: '80', maximumPercentage: '86.99', rate: '24.50' },
      { minimumPercentage: '87', maximumPercentage: '94.99', rate: '25.30' }, { minimumPercentage: '95', maximumPercentage: '99.99', rate: '26.00' },
      { minimumPercentage: '100', maximumPercentage: '', rate: '26.70' },
    ], notes: 'Enter the operator/provider-specific weekly hours. Incentive window: Monday-Friday, 03:15-14:00.' }),
  },
  {
    id: 'div11-bonus-2730', divisionNumber: '11', name: 'DIV 11 Incentive — $27.30 bonus', sourceDocument: 'Div11 Partner Rates.xlsx',
    description: 'Division 11 incentive tiers with the partner-specific $27.30 above-contract bonus rate.',
    version: standard({ basePay: '23.50', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', bonusEnabled: true, bonusRate: '27.30', bonusQualificationMetric: 'ATTAINMENT_HOURS', bonusQualificationPercentage: '100', standbyGuaranteeEnabled: true, incentiveTiers: [
      { minimumPercentage: '0', maximumPercentage: '79.99', rate: '23.50' }, { minimumPercentage: '80', maximumPercentage: '86.99', rate: '24.50' },
      { minimumPercentage: '87', maximumPercentage: '94.99', rate: '25.30' }, { minimumPercentage: '95', maximumPercentage: '99.99', rate: '26.00' },
      { minimumPercentage: '100', maximumPercentage: '', rate: '26.70' },
    ], notes: 'Use only for partners assigned the $27.30 bonus rate in Div11 Partner Rates.xlsx. Incentive window: Monday-Friday, 03:15-14:00.' }),
  },
  {
    id: 'div12-uber-wav', divisionNumber: '12', name: 'DIV 12 Uber WAV', sourceDocument: 'DIV 12.pdf',
    description: 'Philadelphia WAV: 65% core, 94/96/98 fulfillment tiers, acceptance/cancellation and utilization incentives.',
    version: uber({ notes: 'Document example: one unit, 50 weekly contracted hours, $32.50 operator rate; Sunday requires authorization.', uberConfig: { incentiveScope: 'PROVIDER' } }),
  },
  {
    id: 'div13-distance', divisionNumber: '13', name: 'DIV 13 Distance-Based Trips', sourceDocument: 'DIV13.pdf',
    description: 'Attainment-selected trip distance bands with per-mile excess over eight miles and standby guarantee.',
    version: standard({ paymentType: 'PER_TRIP', rateStructureType: 'RATE_CARD', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true, attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER', standbyGuaranteeEnabled: true, rateCards: [
      distanceCard('Core rate', '0', '89.99', '16.90', '21.45', '1.90'),
      distanceCard('90-97.99% incentive rate', '90', '97.99', '18.20', '22.44', '1.95'),
      distanceCard('98%+ incentive rate', '98', '', '19.50', '24.09', '2.00'),
    ], notes: 'Enter the operator/provider-specific weekly hours. Incentive window: Monday-Friday, 06:00-18:00. Service input must preserve trip distance (or grouped trips with equal distance).' }),
  },
];

export function planTemplates() {
  return structuredClone(templates);
}


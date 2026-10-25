export interface VehicleData {
  year: string;
  make: string;
  model: string;
  trim: string;
  bodyClass: string;
  driveType: string;
  fuelType: string;
  doors: string;
  gvwr: string;
  // Fitment inputs (N4-B2): vPIC's dimensional/config fields, when set.
  // wheelBaseIn/bedLengthIn are inch strings ("147.8"); cabType is vPIC's
  // BodyCabType category ("Regular", "Crew/ Super Crew/ Crew Max", …).
  series: string;
  wheelBaseIn: string;
  bedLengthIn: string;
  cabType: string;
}

export async function decodeVIN(vin: string): Promise<VehicleData> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`,
      { signal: c.signal }
    );
    clearTimeout(t);
    const d = await res.json();
    const r = d.Results?.[0];
    if (r?.Make) {
      return {
        year: r.ModelYear || '',
        make: r.Make || '',
        model: r.Model || '',
        trim: r.Trim || '',
        bodyClass: r.BodyClass || '',
        driveType: r.DriveType || '',
        fuelType: r.FuelTypePrimary || '',
        doors: r.Doors || '',
        gvwr: r.GVWR || '',
        series: r.Series || '',
        wheelBaseIn: r.WheelBaseShort || r.WheelBaseLong || '',
        bedLengthIn: r.BedLengthIN || '',
        cabType: r.BodyCabType || '',
      };
    }
  } catch {}
  return offlineDecode(vin);
}

function offlineDecode(vin: string): VehicleData {
  const v = vin.toUpperCase();
  const yearMap: Record<string, string> = {
    A:'2010',B:'2011',C:'2012',D:'2013',E:'2014',F:'2015',G:'2016',H:'2017',
    J:'2018',K:'2019',L:'2020',M:'2021',N:'2022',P:'2023',R:'2024',S:'2025',
    T:'2026',V:'2027',W:'2028','1':'2001','2':'2002','3':'2003','4':'2004',
    '5':'2005','6':'2006','7':'2007','8':'2008','9':'2009',
  };
  const year = yearMap[v[9]] || '';
  const wmi = v.substring(0, 3);
  const wmiMap: Record<string, string> = {
    '1FT':'Ford','2FT':'Ford','3FT':'Ford','1FA':'Ford','1FM':'Ford','3FA':'Ford',
    '1FD':'Ford','1FB':'Ford','1FC':'Ford','1GC':'Chevrolet','1G1':'Chevrolet',
    '2G1':'Chevrolet','1GT':'GMC','1GD':'GMC','1C4':'Jeep','1C6':'RAM','3C6':'RAM',
    '2C3':'Dodge','2D7':'RAM','WDB':'Mercedes-Benz','WDD':'Mercedes-Benz',
    'WDF':'Mercedes-Benz','WD3':'Mercedes-Benz','WD4':'Mercedes-Benz','5J6':'Honda',
    '1HG':'Honda','JTD':'Toyota','4T1':'Toyota','5NM':'Hyundai','5XY':'Kia',
    '1N4':'Nissan','1N6':'Nissan','WBA':'BMW','NM0':'Ford','MAJ':'Ford',
  };
  let make = wmiMap[wmi] || '';
  if (!make) {
    const w2 = v.substring(0, 2);
    const w2Map: Record<string, string> = {
      '1F':'Ford','2F':'Ford','3F':'Ford','1G':'GM','2G':'GM','1C':'Chrysler',
      '2C':'Dodge','3C':'RAM','WD':'Mercedes-Benz','JT':'Toyota','1N':'Nissan','WB':'BMW',
    };
    make = w2Map[w2] || 'Unknown';
  }
  let model = 'Vehicle', bodyClass = '';
  if (make.includes('Ford')) {
    if (v.startsWith('1FTBW') || v.startsWith('1FTNW')) { model = 'Transit'; bodyClass = 'Van'; }
    else if (v.startsWith('1FTBR')) { model = 'Transit'; bodyClass = 'Wagon'; }
    else if (v.startsWith('1FTFW') || v.startsWith('1FTEW')) { model = 'F-150'; bodyClass = 'Pickup'; }
    else if (v.startsWith('1FT7W') || v.startsWith('1FT8W')) { model = 'F-250/F-350'; bodyClass = 'Pickup'; }
    else if (v.startsWith('3FTTW')) { model = 'Transit'; bodyClass = 'Cargo Van'; }
    else if (v.startsWith('MAJ')) { model = 'Transit Connect'; bodyClass = 'Van'; }
    else if (v.startsWith('NM0')) { model = 'Transit'; bodyClass = 'Van'; }
  } else if (make.includes('RAM') || make.includes('Dodge')) {
    if (v[3] === '6') { model = 'ProMaster'; bodyClass = 'Van'; }
    else { model = 'RAM'; bodyClass = 'Pickup/Van'; }
  } else if (make.includes('Mercedes')) {
    model = 'Sprinter'; bodyClass = 'Van';
  }
  return { year, make: make.replace(/ \(.*\)/, ''), model, trim: '', bodyClass, driveType: '', fuelType: '', doors: '', gvwr: '', series: '', wheelBaseIn: '', bedLengthIn: '', cabType: '' };
}

export function isValidVIN(v: string): boolean {
  return !!v && v.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/i.test(v);
}

/** Decoded fields in scan_logs column naming, for direct row spreads. */
export interface DecodedVinFields {
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_trim: string | null;
  body_class: string | null;
}

/**
 * Batch-decode VINs through NHTSA's DecodeVINValuesBatch endpoint, 50 per
 * call. Only full 17-character VINs are sent — the batch endpoint returns
 * nothing useful for partials. Best-effort: a failed batch just means those
 * VINs come back undecoded. Client- and server-safe.
 */
export async function decodeVinsBatch(
  vins: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, DecodedVinFields>> {
  const decoded = new Map<string, DecodedVinFields>();
  const fullVins = [...new Set(vins.filter(v => v.length === 17))];
  for (let i = 0; i < fullVins.length; i += 50) {
    const chunk = fullVins.slice(i, i + 50);
    onProgress?.(Math.min(i + 50, fullVins.length), fullVins.length);
    try {
      const res = await fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `format=json&data=${encodeURIComponent(chunk.join(';'))}`,
      });
      const json = await res.json();
      for (const r of json.Results || []) {
        const v = (r.VIN || '').toUpperCase();
        if (!v) continue;
        decoded.set(v, {
          vehicle_year: r.ModelYear || null,
          vehicle_make: r.Make || null,
          vehicle_model: r.Model || null,
          vehicle_trim: r.Trim || null,
          body_class: r.BodyClass || null,
        });
      }
    } catch {
      // Best-effort; rows still insert without vehicle data.
    }
  }
  return decoded;
}

/** One labelled row in the VIN lookup window; value '' means "not in the VIN". */
export interface VinDetailRow { label: string; value: string; /** Where a value came from, when not NHTSA ("CarsXE · from 145\" wheelbase"). */ note?: string }

export interface VinDetails {
  /** Headline, e.g. "2024 Ford F-150 XLT". Empty when vPIC knew nothing. */
  title: string;
  make: string;
  groups: { heading: string; rows: VinDetailRow[] }[];
  /** vPIC's own warning (bad check digit, partial decode), when it had one. */
  warning: string;
}

const inchesAndFeet = (raw: string): string => {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${+n.toFixed(1)}" (${+(n / 12).toFixed(1)} ft)`;
};

/**
 * Full decode for the stand-alone VIN lookup window: everything vPIC knows
 * that matters for an upfit, grouped for display. Unlike decodeVIN there's no
 * offline guess — the window says plainly what the VIN doesn't carry rather
 * than show a make inferred from the first three characters. Throws when
 * vPIC can't be reached so the window can say so.
 */
export async function decodeVinDetails(vin: string): Promise<VinDetails> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 10000);
  let r: Record<string, string>;
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${encodeURIComponent(vin)}?format=json`,
      { signal: c.signal },
    );
    r = (await res.json()).Results?.[0] || {};
  } finally {
    clearTimeout(t);
  }
  const v = (k: string) => {
    const s = (r[k] || '').trim();
    return s === 'Not Applicable' ? '' : s;
  };
  const engine = [
    v('DisplacementL') && `${+parseFloat(v('DisplacementL')).toFixed(1)}L`,
    v('EngineConfiguration') && v('EngineCylinders')
      ? `${v('EngineConfiguration').replace(/-Shaped/i, '')}${v('EngineCylinders')}`
      : v('EngineCylinders') && `${v('EngineCylinders')} cyl`,
    v('EngineModel'),
  ].filter(Boolean).join(' ');
  const transmission = [v('TransmissionSpeeds') && `${v('TransmissionSpeeds')}-speed`, v('TransmissionStyle')]
    .filter(Boolean).join(' ');
  const wheelbase = v('WheelBaseShort') && v('WheelBaseLong') && v('WheelBaseShort') !== v('WheelBaseLong')
    ? `${v('WheelBaseShort')}" – ${v('WheelBaseLong')}"`
    : inchesAndFeet(v('WheelBaseShort') || v('WheelBaseLong'));
  const plant = [v('PlantCity'), v('PlantState'), v('PlantCountry')]
    .map(s => s.replace(/\s*\(.*\)$/, '')).filter(Boolean).join(', ');

  // vPIC's ErrorCode "0" is a clean decode; anything else carries a
  // human-readable ErrorText ("1 - Check Digit (9th position) does not
  // calculate properly"). Drop its leading code numbers.
  const codes = v('ErrorCode').split(',').map(s => s.trim());
  const warning = codes.length && !codes.every(c => c === '0' || c === '')
    ? v('ErrorText').replace(/^\d+\s*-\s*/, '').replace(/;\s*\d+\s*-\s*/g, '; ')
    : '';

  return {
    title: [v('ModelYear'), v('Make'), v('Model'), v('Trim')].filter(Boolean).join(' '),
    make: v('Make'),
    warning,
    groups: [
      { heading: 'Vehicle', rows: [
        { label: 'Year', value: v('ModelYear') },
        { label: 'Make', value: v('Make') },
        { label: 'Model', value: v('Model') },
        { label: 'Trim', value: [v('Trim'), v('Trim2')].filter(Boolean).join(' / ') },
        { label: 'Series', value: [v('Series'), v('Series2')].filter(Boolean).join(' / ') },
      ] },
      { heading: 'Body', rows: [
        { label: 'Body', value: v('BodyClass') },
        { label: 'Cab', value: v('BodyCabType') },
        { label: 'Bed length', value: inchesAndFeet(v('BedLengthIN')) },
        { label: 'Bed type', value: v('BedType') },
        { label: 'Wheelbase', value: wheelbase },
        { label: 'Doors', value: v('Doors') },
      ] },
      { heading: 'Drivetrain', rows: [
        { label: 'Drive', value: v('DriveType') },
        { label: 'Engine', value: engine },
        { label: 'Fuel', value: [v('FuelTypePrimary'), v('FuelTypeSecondary')].filter(Boolean).join(' / ') },
        { label: 'Transmission', value: transmission },
      ] },
      { heading: 'Weight', rows: [
        { label: 'GVWR', value: v('GVWR') },
        { label: 'Curb weight', value: v('CurbWeightLB') && `${v('CurbWeightLB')} lb` },
      ] },
      { heading: 'Built', rows: [
        { label: 'Plant', value: plant },
        { label: 'Maker', value: v('Manufacturer') },
      ] },
    ],
  };
}

/**
 * The maker's own window sticker for a VIN, where the maker publishes one —
 * it lists the factory options (bed length, axle, packages) the VIN itself
 * doesn't encode. Newer vehicles only; older or fleet-ordered ones can 404.
 */
export function windowStickerUrl(make: string, vin: string): string | null {
  const m = make.toUpperCase();
  const v = encodeURIComponent(vin);
  if (/FORD|LINCOLN/.test(m)) return `https://www.windowsticker.forddirect.com/windowsticker.pdf?vin=${v}`;
  if (/CHEVROLET|GMC|BUICK|CADILLAC/.test(m)) return `https://cws.gm.com/vs-cws/vehshop/v2/vehicle/windowsticker?vin=${v}`;
  if (/RAM|DODGE|JEEP|CHRYSLER/.test(m)) return `https://www.chrysler.com/hostd/windowsticker/getWindowStickerPdf.do?vin=${v}`;
  return null;
}

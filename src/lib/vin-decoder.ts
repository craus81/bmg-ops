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
  return { year, make: make.replace(/ \(.*\)/, ''), model, trim: '', bodyClass, driveType: '', fuelType: '', doors: '', gvwr: '' };
}

export function isValidVIN(v: string): boolean {
  return !!v && v.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/i.test(v);
}

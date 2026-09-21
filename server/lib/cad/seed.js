// server/lib/cad/seed.js
// Seeds ~20 fictional London/MET-themed PNC vehicle + person records. Idempotent:
// vehicles upsert by VRM; persons are only inserted if the table is empty. Safe
// to run repeatedly (called from the dev console "Seed PNC" button).
const prisma = require('../db');

const VEHICLES = [
  { vrm: 'LG21XYZ', make: 'Ford',        model: 'Focus',     colour: 'Blue',   registeredKeeper: 'A. Whitfield',   taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: [],                         stolen: false },
  { vrm: 'BD19KLM', make: 'Vauxhall',    model: 'Corsa',     colour: 'Silver', registeredKeeper: 'R. Okafor',      taxStatus: 'Untaxed', motStatus: 'Expired', insuranceStatus: 'Uninsured', markers: ['No insurance'],           stolen: false },
  { vrm: 'LK68TRD', make: 'BMW',         model: '320d',      colour: 'Black',  registeredKeeper: 'M. Petrova',     taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: ['Police interest'],        stolen: false },
  { vrm: 'GF15NHK', make: 'Audi',        model: 'A3',        colour: 'Grey',   registeredKeeper: 'S. Kaur',        taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: [],                         stolen: false },
  { vrm: 'RE64WPO', make: 'Volkswagen',  model: 'Golf',      colour: 'White',  registeredKeeper: 'T. Nkemelu',     taxStatus: 'SORN',    motStatus: 'None',    insuranceStatus: 'Unknown',   markers: ['SORN declared'],          stolen: false },
  { vrm: 'HN17ZBC', make: 'Mercedes',    model: 'C-Class',   colour: 'Blue',   registeredKeeper: 'D. Fairweather', taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: [],                         stolen: false },
  { vrm: 'YT66FVR', make: 'Toyota',      model: 'Yaris',     colour: 'Red',    registeredKeeper: 'C. Blackwood',   taxStatus: 'Untaxed', motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: ['Untaxed'],                stolen: false },
  { vrm: 'AV13JQE', make: 'Nissan',      model: 'Qashqai',   colour: 'Bronze', registeredKeeper: 'P. Adeyemi',     taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: [],                         stolen: false },
  { vrm: 'SN70MDX', make: 'Range Rover', model: 'Evoque',    colour: 'Black',  registeredKeeper: 'L. Marchetti',   taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: ['Cloned plate suspected'], stolen: true  },
  { vrm: 'EK18GHT', make: 'Honda',       model: 'Civic',     colour: 'White',  registeredKeeper: 'J. O’Sullivan',  taxStatus: 'Taxed',   motStatus: 'Expired', insuranceStatus: 'Insured',   markers: ['No current MOT'],         stolen: false },
  { vrm: 'WM62XLA', make: 'Peugeot',     model: '208',       colour: 'Grey',   registeredKeeper: 'B. Haddad',      taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: [],                         stolen: false },
  { vrm: 'CV16TYU', make: 'Kia',         model: 'Sportage',  colour: 'Silver', registeredKeeper: 'N. Ellison',     taxStatus: 'Untaxed', motStatus: 'Expired', insuranceStatus: 'Uninsured', markers: ['Untaxed', 'No insurance'],stolen: false },
  { vrm: 'LB67RPS', make: 'Mercedes',    model: 'Sprinter',  colour: 'White',  registeredKeeper: 'Capital Couriers Ltd', taxStatus: 'Taxed', motStatus: 'Valid', insuranceStatus: 'Insured', markers: ['Commercial vehicle'],  stolen: false },
  { vrm: 'GX14HND', make: 'Ford',        model: 'Transit',   colour: 'Blue',   registeredKeeper: 'Thameside Plumbing', taxStatus: 'Taxed', motStatus: 'Valid',  insuranceStatus: 'Insured',   markers: [],                         stolen: false },
  { vrm: 'MP69CAD', make: 'BMW',         model: 'X5',        colour: 'Black',  registeredKeeper: 'Metropolitan Police (marked)', taxStatus: 'Taxed', motStatus: 'Valid', insuranceStatus: 'Insured', markers: ['Police vehicle'], stolen: false },
  { vrm: 'OU12KWE', make: 'Suzuki',      model: 'Swift',     colour: 'Yellow', registeredKeeper: 'F. Delacroix',   taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: [],                         stolen: false },
  { vrm: 'PL15VNB', make: 'Land Rover',  model: 'Defender',  colour: 'Green',  registeredKeeper: 'H. Ashcombe',    taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: ['Firearms — registered keeper certificate holder'], stolen: false },
  { vrm: 'DA20QRS', make: 'Tesla',       model: 'Model 3',   colour: 'White',  registeredKeeper: 'V. Ramanathan',  taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: [],                         stolen: false },
  { vrm: 'RK66STV', make: 'Vauxhall',    model: 'Astra',     colour: 'Red',    registeredKeeper: 'G. Mbeki',       taxStatus: 'Untaxed', motStatus: 'Expired', insuranceStatus: 'Uninsured', markers: ['STOLEN — do not stop, follow'], stolen: true },
  { vrm: 'TN18ABX', make: 'Skoda',       model: 'Octavia',   colour: 'Grey',   registeredKeeper: 'W. Kowalski',    taxStatus: 'Taxed',   motStatus: 'Valid',   insuranceStatus: 'Insured',   markers: [],                         stolen: false },
];

const PERSONS = [
  { forename: 'Aaron',    surname: 'Whitfield',   dob: '1994-03-12', address: '14 Bermondsey Street, London SE1',        warningMarkers: [],                              wanted: false },
  { forename: 'Rita',     surname: 'Okafor',      dob: '1988-11-02', address: '5 Deptford High Street, London SE8',       warningMarkers: ['Alerts — mental health'],      wanted: false },
  { forename: 'Marta',    surname: 'Petrova',     dob: '1996-07-21', address: '22 Hackney Road, London E2',               warningMarkers: ['Violence'],                    wanted: true  },
  { forename: 'Simran',   surname: 'Kaur',        dob: '2000-01-30', address: '9 Southall Broadway, London UB1',          warningMarkers: [],                              wanted: false },
  { forename: 'Tobi',     surname: 'Nkemelu',     dob: '1991-05-16', address: '31 Peckham Rye, London SE15',              warningMarkers: ['Drugs'],                       wanted: false },
  { forename: 'Daniel',   surname: 'Fairweather', dob: '1985-09-09', address: '18 Notting Hill Gate, London W11',         warningMarkers: [],                              wanted: false },
  { forename: 'Chloe',    surname: 'Blackwood',   dob: '1999-12-04', address: '2 Camden Lock Place, London NW1',          warningMarkers: ['Weapons', 'Violence'],         wanted: true  },
  { forename: 'Peter',    surname: 'Adeyemi',     dob: '1979-06-25', address: '47 Brixton Hill, London SW2',              warningMarkers: [],                              wanted: false },
  { forename: 'Luca',     surname: 'Marchetti',   dob: '1990-02-14', address: '8 Clerkenwell Road, London EC1',           warningMarkers: ['Wanted on recall to prison'],  wanted: true  },
  { forename: 'Jack',     surname: "O'Sullivan",  dob: '1997-08-19', address: '60 Kilburn High Road, London NW6',         warningMarkers: [],                              wanted: false },
  { forename: 'Bilal',    surname: 'Haddad',      dob: '1993-04-27', address: '11 Whitechapel Road, London E1',           warningMarkers: ['Alerts — self-harm'],          wanted: false },
  { forename: 'Nadia',    surname: 'Ellison',     dob: '1986-10-10', address: '3 Greenwich Church Street, London SE10',   warningMarkers: [],                              wanted: false },
  { forename: 'Femi',     surname: 'Delacroix',   dob: '2001-03-03', address: '25 Dalston Lane, London E8',               warningMarkers: ['Drugs'],                       wanted: false },
  { forename: 'Harriet',  surname: 'Ashcombe',    dob: '1975-07-07', address: 'The Coach House, Richmond Hill, TW10',     warningMarkers: ['Firearms certificate holder'], wanted: false },
  { forename: 'Vikram',   surname: 'Ramanathan',  dob: '1989-01-18', address: '40 Canary Wharf, London E14',             warningMarkers: [],                              wanted: false },
  { forename: 'George',   surname: 'Mbeki',       dob: '1992-11-29', address: '16 Tottenham High Road, London N17',       warningMarkers: ['Violence', 'Fails to stop'],   wanted: true  },
  { forename: 'Wiktor',   surname: 'Kowalski',    dob: '1984-05-05', address: '7 Ealing Broadway, London W5',             warningMarkers: [],                              wanted: false },
  { forename: 'Amara',    surname: 'Boateng',     dob: '1998-09-22', address: '19 Lewisham Way, London SE4',              warningMarkers: [],                              wanted: false },
  { forename: 'Sofia',    surname: 'Ricci',       dob: '1995-06-30', address: '12 Islington Green, London N1',            warningMarkers: ['Alerts — missing person history'], wanted: false },
  { forename: 'Callum',   surname: 'Fraser',      dob: '1983-02-11', address: '9 Wandsworth High Street, London SW18',    warningMarkers: [],                              wanted: false },
];

async function seedPnc() {
  let vehicles = 0, persons = 0;
  for (const v of VEHICLES) {
    await prisma.cadVehicleRecord.upsert({ where: { vrm: v.vrm }, update: v, create: v }).then(() => vehicles++).catch(() => {});
  }
  const existingPersons = await prisma.cadPersonRecord.count().catch(() => 0);
  if (existingPersons === 0) {
    for (const p of PERSONS) { await prisma.cadPersonRecord.create({ data: p }).then(() => persons++).catch(() => {}); }
  }
  return { vehicles, persons, personsSkipped: existingPersons > 0 };
}

module.exports = { seedPnc, VEHICLES, PERSONS };

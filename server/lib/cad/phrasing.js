// server/lib/cad/phrasing.js
// Turns CAD state into UK police-radio phrasing (spoken by TTS + mirrored to
// #radio). Pure string builders — no side effects — so they're easy to test and
// reuse across the web console and the radio channel.
const GRADE_WORD = { I: 'Grade one', S: 'Grade two significant', E: 'Grade three', R: 'Grade four' };

function statusPhrase(status) {
  switch (status) {
    case 'AVAILABLE':          return 'shown available';
    case 'EN_ROUTE':           return 'shown en route';
    case 'ON_SCENE':           return 'shown on scene';
    case 'BUSY':               return 'shown state busy';
    case 'MEAL_BREAK':         return 'shown on refs';           // UK: "refs" = meal break
    case 'URGENT_ASSISTANCE':  return 'showing urgent assistance';
    case 'OFF_DUTY':           return 'shown off duty';
    default:                   return 'received';
  }
}

// "MP-1, control receiving, you are shown en route."
function ackStatus(callsign, status) {
  return `${callsign}, control receiving, you are ${statusPhrase(status)}.`;
}
function ackBookOn(callsign, officerName) {
  return `${callsign}, control receiving, you are booked on and shown available. Have a safe shift.`;
}
function ackBookOff(callsign) {
  return `${callsign}, control receiving, you are booked off. Goodnight.`;
}

// "MP-3, PNC check on Lima Golf two one, X-ray Yankee Zulu. Vehicle shows..."
function vehicleResult(callsign, vrm, res) {
  if (!res.found || !res.record) return `${callsign}, negative trace on ${vrm}. No current record held.`;
  const r = res.record;
  const flags = [];
  if (/untax/i.test(r.taxStatus)) flags.push('untaxed'); else if (/sorn/i.test(r.taxStatus)) flags.push('SORN declared');
  if (/expire|none/i.test(r.motStatus)) flags.push('no current MOT');
  if (/uninsur/i.test(r.insuranceStatus)) flags.push('shows as uninsured');
  if (r.stolen) flags.push('reported STOLEN');
  const markers = (r.markers || []).length ? ` Markers: ${r.markers.join(', ')}.` : '';
  const head = `${callsign}, that VRM shows as a ${r.colour} ${r.make} ${r.model}, registered keeper ${r.registeredKeeper}.`;
  const tail = flags.length ? ` Be aware — vehicle ${flags.join(', ')}.` : ' Vehicle shows all in order — taxed, MOT and insurance valid.';
  return head + tail + markers;
}

function personResult(callsign, res) {
  if (!res.found || !res.records.length) return `${callsign}, negative trace, no person record held on that name.`;
  if (res.records.length > 1) {
    const names = res.records.slice(0, 4).map(p => `${p.forename} ${p.surname}`).join(', ');
    return `${callsign}, multiple records on that surname — ${names}. Confirm a forename to narrow it down.`;
  }
  const p = res.records[0];
  const flags = [];
  if (p.wanted) flags.push('subject is WANTED');
  if ((p.warningMarkers || []).length) flags.push(`warning markers: ${p.warningMarkers.join(', ')}`);
  const head = `${callsign}, one record — ${p.forename} ${p.surname}, date of birth ${p.dob}, last known address ${p.address}.`;
  const tail = flags.length ? ` Caution — ${flags.join('; ')}.` : ' No markers or warnings held.';
  return head + tail;
}

function incidentCreated(inc) {
  return `${inc.cadRef}, ${GRADE_WORD[inc.grade] || 'incident'}, ${inc.category} at ${inc.location}. Any unit free to attend.`;
}
function ackAssign(callsign, inc) {
  return `${callsign}, assigned to ${inc.cadRef}, ${inc.category} at ${inc.location}. You are shown en route.`;
}
function ackClose(inc) {
  return `All units, ${inc.cadRef} is now closed${inc.closedOutcome ? ` — ${inc.closedOutcome}` : ''}. Units are released and shown available.`;
}
// "All units, urgent assistance required from MP-1, last known location
//  Trafalgar Square. Any unit free to attend."
function backupAlert(callsign, location) {
  return `All units, all units — urgent assistance required from ${callsign}, last known location ${location}. Any unit free to attend, make your way.`;
}
function repeat(callsign) {
  return `${callsign || 'Last unit'}, control, you were unreadable — say again your last.`;
}

module.exports = {
  GRADE_WORD, statusPhrase, ackStatus, ackBookOn, ackBookOff,
  vehicleResult, personResult, incidentCreated, ackAssign, ackClose, backupAlert, repeat,
};

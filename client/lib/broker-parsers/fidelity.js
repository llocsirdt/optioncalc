// Fidelity brokerage CSV adapter for the broker-import pipeline (see broker-import.js).
// Every adapter registers into window.BrokerImportParsers with this contract:
//   { label: string, detect(csvText) -> boolean, extractLegs(csvText) -> { legs, skippedCount, totalRows } }
// `legs` entries are { qty, type ('c'|'p'), strike, cost, root, expiration } — cost follows the
// optionArray convention (+ = debit paid, - = credit received).

const FIDELITY_MONTH_NUMBERS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

function fidelityParseRows(text) {
  const rows = parseCsvText(text); // shared CSV tokenizer from broker-import.js
  const headerIndex = rows.findIndex((r) => (r[0] || '').trim() === 'Run Date');
  if (headerIndex === -1) {
    throw new Error('Could not find the "Run Date" header row — is this a Fidelity transaction history CSV?');
  }
  const header = rows[headerIndex].map((h) => h.trim());
  return rows
    .slice(headerIndex + 1)
    .filter((r) => r.length === header.length)
    .map((r) => {
      const obj = {};
      header.forEach((key, i) => { obj[key] = (r[i] || '').trim(); });
      return obj;
    });
}

function fidelityParseOptionDescription(description) {
  const match = description.match(
    /^(CALL|PUT)\s*\((\w+)\)\s+.+?\s+([A-Z]{3})\s+(\d{1,2})\s+(\d{2})\s+\$([\d,.]+)/i,
  );
  if (!match) return null;

  const [, callPut, root, monthName, day, yearTwoDigit, strikeText] = match;
  const month = FIDELITY_MONTH_NUMBERS[monthName.toUpperCase()];
  if (!month) return null;

  return {
    type: callPut.toUpperCase() === 'CALL' ? 'c' : 'p',
    root: root.toUpperCase(),
    expiration: `20${yearTwoDigit}-${month}-${day.padStart(2, '0')}`,
    strike: parseFloat(strikeText.replace(/,/g, '')),
  };
}

function fidelityDetect(csvText) {
  return /^Run Date,/m.test(csvText) || csvText.includes('Run Date,Action,Symbol');
}

function fidelityExtractLegs(csvText) {
  const rowObjects = fidelityParseRows(csvText);
  const legs = [];
  let skippedCount = 0;

  rowObjects.forEach((row) => {
    const action = (row.Action || '').toUpperCase();

    if (action.includes('EXPIRED') || action.includes('ASSIGNED') || action.includes('EXERCISED')) {
      skippedCount++;
      return;
    }
    if (!action.includes('OPENING TRANSACTION')) {
      skippedCount++;
      return;
    }

    const parsed = fidelityParseOptionDescription(row.Description || '');
    if (!parsed) {
      skippedCount++;
      return;
    }

    const qty = parseInt(row.Quantity, 10);
    const amount = parseFloat(row['Amount ($)'] || row.Amount || '0');
    if (Number.isNaN(qty) || Number.isNaN(amount)) {
      skippedCount++;
      return;
    }

    legs.push({
      qty,
      type: parsed.type,
      strike: parsed.strike,
      cost: Math.round(-amount),
      root: parsed.root,
      expiration: parsed.expiration,
    });
  });

  return { legs, skippedCount, totalRows: rowObjects.length };
}

(window.BrokerImportParsers = window.BrokerImportParsers || {}).fidelity = {
  label: 'Fidelity',
  detect: fidelityDetect,
  extractLegs: fidelityExtractLegs,
};

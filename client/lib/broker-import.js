// Broker-agnostic CSV import: converts brokerage transaction history into the
// leg-string format the calculator's optionArray expects
// (e.g. "1c28330@16113,-1c28370@-14011"), grouped by underlying root + expiration.
//
// Per-broker parsing lives in client/lib/broker-parsers/*.js, each registering into
// window.BrokerImportParsers — see broker-parsers/fidelity.js for the adapter contract.

window.BrokerImportParsers = window.BrokerImportParsers || {};

let brokerImportGroups = [];

function toggleBrokerImportPanel() {
  const container = document.getElementById('broker-import-container');
  if (!container) return;
  const isHidden = container.style.display === 'none';
  container.style.display = isHidden ? '' : 'none';
}

// Reveal the "additional options" panel (paste CSV + source select).
function showBrokerImportPanel() {
  const container = document.getElementById('broker-import-container');
  if (container) container.style.display = '';
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function detectBrokerSource(csvText) {
  return Object.keys(window.BrokerImportParsers).find((key) => {
    try {
      return window.BrokerImportParsers[key].detect(csvText);
    } catch {
      return false;
    }
  }) || null;
}

function groupLegsByExpiration(legs) {
  const groups = new Map();
  legs.forEach((leg) => {
    const key = `${leg.root}_${leg.expiration}`;
    if (!groups.has(key)) {
      groups.set(key, { root: leg.root, expiration: leg.expiration, legs: [] });
    }
    groups.get(key).legs.push(leg);
  });
  return Array.from(groups.values()).sort((a, b) => a.expiration.localeCompare(b.expiration));
}

function legsToOptionArrayString(legs) {
  return legs.map((leg) => `${leg.qty}${leg.type}${leg.strike}@${leg.cost}`).join(',');
}

function buildOptionArrayFromCsv(csvText, sourceKey) {
  const key = sourceKey && sourceKey !== 'auto' ? sourceKey : detectBrokerSource(csvText);
  const parser = key && window.BrokerImportParsers[key];
  if (!parser) {
    throw new Error('Could not detect the brokerage for this CSV — pick a source explicitly.');
  }

  const { legs, skippedCount, totalRows } = parser.extractLegs(csvText);
  const groups = groupLegsByExpiration(legs).map((group) => ({
    ...group,
    optionArrayString: legsToOptionArrayString(group.legs),
  }));
  return { groups, skippedCount, totalRows, source: key };
}

function renderBrokerImportResults(result) {
  const container = document.getElementById('broker-import-results');
  if (!container) return;

  if (result.groups.length === 0) {
    container.innerHTML = '<p>No opening option transactions found in this CSV.</p>';
    return;
  }

  const label = (window.BrokerImportParsers[result.source] || {}).label || result.source;
  container.innerHTML = `<p class="broker-import-source">Detected source: ${label}</p>` + result.groups
    .map((group, index) => `
      <div class="broker-import-group">
        <strong>${group.root} — exp ${group.expiration}</strong> (${group.legs.length} leg${group.legs.length === 1 ? '' : 's'})
        <div class="broker-import-code">${group.optionArrayString}</div>
        <button onclick="loadBrokerImportGroupIntoTextarea(${index})">Load into calculator</button>
      </div>
    `)
    .join('');
}

function runBrokerImport(csvText, sourceKey) {
  const container = document.getElementById('broker-import-results');
  try {
    const result = buildOptionArrayFromCsv(csvText, sourceKey);
    brokerImportGroups = result.groups;

    // Common case: a single position group — load it straight into the
    // calculator so "choose file → Import" is all that's needed. Multiple
    // groups (e.g. several expirations/underlyings) still show a picker.
    if (result.groups.length === 1) {
      renderBrokerImportResults(result);
      loadBrokerImportGroupIntoTextarea(0);
    } else {
      showBrokerImportPanel(); // make sure the picker is visible
      renderBrokerImportResults(result);
    }
  } catch (err) {
    brokerImportGroups = [];
    showBrokerImportPanel();
    if (container) container.innerHTML = `<p class="broker-import-error">${err.message}</p>`;
  }
}

function importBrokerCsv() {
  const fileInput = document.getElementById('broker-csv-file');
  const pasteArea = document.getElementById('broker-csv-paste');
  const sourceSelect = document.getElementById('broker-source-select');
  const sourceKey = sourceSelect ? sourceSelect.value : 'auto';
  const file = fileInput && fileInput.files && fileInput.files[0];

  if (file) {
    const reader = new FileReader();
    reader.onload = (e) => runBrokerImport(e.target.result, sourceKey);
    reader.readAsText(file);
  } else if (pasteArea && pasteArea.value.trim()) {
    runBrokerImport(pasteArea.value, sourceKey);
  } else {
    // No file and nothing pasted: open the additional panel so the user can
    // paste CSV text or pick a source, rather than erroring.
    showBrokerImportPanel();
    const paste = document.getElementById('broker-csv-paste');
    if (paste) paste.focus();
  }
}

function loadBrokerImportGroupIntoTextarea(index) {
  const group = brokerImportGroups[index];
  if (!group) return;

  const textInput = document.getElementById('textInput');
  if (!textInput) return;

  textInput.value = JSON.stringify({ optionArray: group.optionArrayString }, null, 2);
  processInput();
}

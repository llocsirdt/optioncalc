// Expiration dropdown functionality
let selectedExpiration = null;
let availableExpirations = [];

// Load expirations for current symbol
async function loadExpirations() {
  const symbol = document.getElementById('symbol-input').value.trim();
  const dropdown = document.getElementById('expiration-dropdown');
  
  if (!symbol) {
    console.log('❌ No symbol entered');
    return;
  }
  
  console.log(`🔄 Loading expirations for ${symbol}...`);
  dropdown.innerHTML = '<option value="">Loading expirations...</option>';
  
  try {
    // Get expirations from Schwab API
    const chainsSymbol = mapSymbolForAPI(symbol, 'chains');
    const expirations = await getOptionExpirationsFromSchwab(chainsSymbol);
    
    if (expirations && expirations.expirationList && expirations.expirationList.length > 0) {
      availableExpirations = expirations.expirationList;
      populateExpirationDropdown(availableExpirations);
      
      // Auto-select today's expiration if available
      const today = new Date();
      const todayString = today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD format in EST/EDT
      const todayExpiration = availableExpirations.find(exp => exp.expirationDate === todayString);
      
      if (todayExpiration) {
        dropdown.value = todayExpiration.expirationDate;
        selectedExpiration = todayExpiration.expirationDate;
        console.log(`🎯 Auto-selected today's expiration: ${selectedExpiration}`);
        // Trigger input restoration for auto-selected expiration
        const symbol = document.getElementById('symbol-input').value.trim();
        if (symbol && typeof restoreAppropriateInput === 'function') {
          // console.log(`🔄 Auto-selection - restoring input for ${symbol} ${selectedExpiration}`);
          restoreAppropriateInput(symbol, selectedExpiration);
        }
      } else if (availableExpirations.length > 0) {
        // Select the nearest expiration
        dropdown.value = availableExpirations[0].expirationDate;
        selectedExpiration = availableExpirations[0].expirationDate;
        console.log(`🎯 Selected nearest expiration: ${selectedExpiration}`);
        // Trigger input restoration for auto-selected expiration
        const symbol = document.getElementById('symbol-input').value.trim();
        if (symbol && typeof restoreAppropriateInput === 'function') {
          // console.log(`🔄 Auto-selection - restoring input for ${symbol} ${selectedExpiration}`);
          restoreAppropriateInput(symbol, selectedExpiration);
        }
      }
    } else {
      dropdown.innerHTML = '<option value="">No expirations available</option>';
      console.log('❌ No expirations found');
    }
  } catch (error) {
    console.error('❌ Error loading expirations:', error);
    dropdown.innerHTML = '<option value="">Error loading expirations</option>';
  }
}

// Populate expiration dropdown
function populateExpirationDropdown(expirationList) {
  const dropdown = document.getElementById('expiration-dropdown');
  dropdown.innerHTML = '';
  
  // Sort expirations by date
  const sortedExpirations = expirationList.sort((a, b) => {
    return new Date(a.expirationDate) - new Date(b.expirationDate);
  });
  
  sortedExpirations.forEach(expiration => {
    const option = document.createElement('option');
    option.value = expiration.expirationDate;
    
    // Format display text - handle timezone correctly
    const date = new Date(expiration.expirationDate + 'T12:00:00'); // Add noon to avoid timezone issues
    const formattedDate = date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric',
      timeZone: 'America/New_York' // Explicitly use EST/EDT
    });
    
    let displayText = `${formattedDate}`;
    if (expiration.daysToExpiration !== undefined) {
      displayText += ` (${expiration.daysToExpiration} days)`;
    }
    
    option.textContent = displayText;
    dropdown.appendChild(option);
  });
  
  console.log(`✅ Loaded ${expirationList.length} expirations`);
}

// Update selected expiration date
function updateExpirationDate() {
  const dropdown = document.getElementById('expiration-dropdown');
  selectedExpiration = dropdown.value;
  
  // console.log(`🎯 updateExpirationDate called - selected expiration: "${selectedExpiration}"`);
  
  if (selectedExpiration) {
    // console.log(`🎯 Selected expiration: ${selectedExpiration}`);
    
    // Restore appropriate input for this symbol+expiration combination
    const symbol = document.getElementById('symbol-input').value.trim();
    // console.log(`🔍 Current symbol: "${symbol}"`);
    
    if (symbol && typeof restoreAppropriateInput === 'function') {
      // console.log(`🔍 Calling restoreAppropriateInput...`);
      restoreAppropriateInput(symbol, selectedExpiration);
    } else {
      // console.log(`❌ Cannot restore input - symbol: "${symbol}", function exists: ${typeof restoreAppropriateInput === 'function'}`);
    }
    
    // Trigger options chain refresh with new expiration
    if (symbol) {
      // console.log(`🔄 Refreshing options chain for ${symbol} with expiration ${selectedExpiration}`);
      // This will be used by the existing options chain logic
    }
  } else {
    // console.log('⚠️ No expiration selected');
    
    // If no expiration selected, restore default input
    const symbol = document.getElementById('symbol-input').value.trim();
    if (symbol && typeof restoreAppropriateInput === 'function') {
      // console.log(`🔍 No expiration - restoring default input for symbol: ${symbol}`);
      restoreAppropriateInput(symbol, '');
    }
  }
}

// Get selected expiration for API calls
function getSelectedExpiration() {
  return selectedExpiration;
}

// Initialize expirations when symbol changes and on page load
document.addEventListener('DOMContentLoaded', function() {
  const symbolInput = document.getElementById('symbol-input');
  if (symbolInput) {
    symbolInput.addEventListener('change', function() {
      // console.log(`🔄 Symbol changed to: "${symbolInput.value.trim()}"`);
      loadExpirations();
      
      // Restore appropriate input for new symbol
      const symbol = symbolInput.value.trim();
      const expiration = document.getElementById('expiration-dropdown')?.value;
      // console.log(`🔍 After symbol change - symbol: "${symbol}", expiration: "${expiration}"`);
      
      if (typeof restoreAppropriateInput === 'function') {
        // console.log(`🔍 Calling restoreAppropriateInput from symbol change handler...`);
        restoreAppropriateInput(symbol, expiration);
      } else {
        // console.log(`❌ restoreAppropriateInput function not available`);
      }
    });
    
    // Load expirations for initial symbol on page load
    if (symbolInput.value.trim()) {
      console.log('🔄 Auto-loading expirations on page load for:', symbolInput.value);
      setTimeout(() => {
        loadExpirations();
      }, 500); // Small delay to ensure everything is loaded
    } else {
      // If no symbol, set placeholder
      const dropdown = document.getElementById('expiration-dropdown');
      if (dropdown) {
        dropdown.innerHTML = '<option value="">Enter symbol to load expirations</option>';
      }
    }
  }
});

// Additional fallback - try to load after window fully loads
window.addEventListener('load', function() {
  const symbolInput = document.getElementById('symbol-input');
  const dropdown = document.getElementById('expiration-dropdown');
  
  if (symbolInput && dropdown && symbolInput.value.trim() && dropdown.options.length === 1) {
    console.log('🔄 Fallback: Loading expirations after window load');
    setTimeout(() => {
      loadExpirations();
    }, 1000);
  }
  
  // Update connection button visibility on page load
  updateConnectionButtonVisibility();
});

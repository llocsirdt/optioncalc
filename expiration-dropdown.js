// Use global functions (for file:// protocol compatibility)
// restoreAppropriateInput is available via window object from oc.js

// Expiration dropdown functionality
let selectedExpiration = null;
let availableExpirations = [];
let loadExpirationsTimeout = null;

// Save selected expiration to localStorage
function saveSelectedExpiration(symbol, expiration) {
  if (!symbol || !expiration) return;
  
  // Only save if symbol is reasonably complete (at least 2 characters)
  if (symbol.length < 2) {
    console.log(`⚠️ Symbol too short to save: "${symbol}"`);
    return;
  }
  
  const key = `selectedExpiration_${symbol.toUpperCase()}`;
  console.log(`💾 Attempting to save - Key: ${key}, Value: ${expiration}`);
  localStorage.setItem(key, expiration);
  
  // Verify it was saved
  const verify = localStorage.getItem(key);
  console.log(`💾 Verification - Saved: ${verify}, Expected: ${expiration}, Match: ${verify === expiration}`);
  console.log(`💾 Saved selected expiration for ${symbol}: ${expiration}`);
}

// Get saved expiration for symbol
function getSavedExpiration(symbol) {
  if (!symbol) return null;
  
  const key = `selectedExpiration_${symbol.toUpperCase()}`;
  const saved = localStorage.getItem(key);
  console.log(`📖 Retrieving - Key: ${key}, Found: ${saved || 'none'}`);
  console.log(`📖 Retrieved saved expiration for ${symbol}: ${saved || 'none'}`);
  return saved;
}

// Clear saved expiration for symbol
function clearSavedExpiration(symbol) {
  if (!symbol) return;
  
  const key = `selectedExpiration_${symbol.toUpperCase()}`;
  localStorage.removeItem(key);
  console.log(`🗑️ Cleared saved expiration for ${symbol}`);
}

// Clear all saved expirations (for debugging/reset)
function clearAllSavedExpirations() {
  const keys = Object.keys(localStorage);
  let clearedCount = 0;
  
  keys.forEach(key => {
    if (key.startsWith('selectedExpiration_')) {
      localStorage.removeItem(key);
      clearedCount++;
    }
  });
  
  console.log(`🗑️ Cleared ${clearedCount} saved expirations`);
  return clearedCount;
}

// Load expirations for current symbol
async function loadExpirations() {
  const symbol = document.getElementById('symbol-input').value.trim();
  const dropdown = document.getElementById('expiration-dropdown');
  
  if (!symbol) {
    console.log('❌ No symbol entered');
    return;
  }
  
  // Only proceed if symbol is reasonably complete
  if (symbol.length < 2) {
    console.log(`⚠️ Symbol too short to load expirations: "${symbol}"`);
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
      
      // Try to restore previously selected expiration first
      const savedExpiration = getSavedExpiration(symbol);
      let selectedDate = null;
      
      // Debug: Show all available expirations
      console.log(`🔍 Available expirations for ${symbol}:`);
      availableExpirations.forEach((exp, index) => {
        console.log(`  [${index}] ${exp.expirationDate}`);
      });
      
      if (savedExpiration) {
        // Check if saved expiration is still available
        const savedExpirationObj = availableExpirations.find(exp => exp.expirationDate === savedExpiration);
        if (savedExpirationObj) {
          selectedDate = savedExpiration;
          dropdown.value = savedExpiration;
          selectedExpiration = savedExpiration;
          console.log(`🔄 Restored saved expiration: ${selectedExpiration}`);
        } else {
          console.log(`⚠️ Saved expiration ${savedExpiration} not available for ${symbol}`);
          console.log(`⚠️ Available dates: ${availableExpirations.map(exp => exp.expirationDate).join(', ')}`);
          clearSavedExpiration(symbol); // Clear invalid saved expiration
        }
      }
      
      // If no valid saved expiration, auto-select today's or nearest
      if (!selectedDate) {
        const today = new Date();
        const todayString = today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD format in EST/EDT
        const todayExpiration = availableExpirations.find(exp => exp.expirationDate === todayString);
        
        if (todayExpiration) {
          selectedDate = todayExpiration.expirationDate;
          dropdown.value = todayExpiration.expirationDate;
          selectedExpiration = todayExpiration.expirationDate;
          console.log(`🎯 Auto-selected today's expiration: ${selectedExpiration}`);
        } else if (availableExpirations.length > 0) {
          // Select the nearest expiration
          selectedDate = availableExpirations[0].expirationDate;
          dropdown.value = availableExpirations[0].expirationDate;
          selectedExpiration = availableExpirations[0].expirationDate;
          console.log(`🎯 Selected nearest expiration: ${selectedExpiration}`);
        }
      }
      
      // Save the selected expiration and trigger input restoration
      if (selectedDate) {
        saveSelectedExpiration(symbol, selectedDate);
        const symbolInput = document.getElementById('symbol-input').value.trim();
        if (symbolInput && typeof restoreAppropriateInput === 'function') {
          // console.log(`🔄 Auto-selection - restoring input for ${symbolInput} ${selectedDate}`);
          restoreAppropriateInput(symbolInput, selectedDate);
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
    // Save the selected expiration for the current symbol
    const symbol = document.getElementById('symbol-input').value.trim();
    if (symbol) {
      saveSelectedExpiration(symbol, selectedExpiration);
      console.log(`💾 Updated selected expiration for ${symbol}: ${selectedExpiration}`);
    }
    
    // console.log(`🎯 Selected expiration: ${selectedExpiration}`);
    
    // Restore appropriate input for this symbol+expiration combination
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

// Debounced version of loadExpirations to prevent rapid calls
function debouncedLoadExpirations() {
  if (loadExpirationsTimeout) {
    clearTimeout(loadExpirationsTimeout);
  }
  
  loadExpirationsTimeout = setTimeout(() => {
    loadExpirations();
  }, 300); // Wait 300ms after typing stops
}

// Initialize expirations when symbol changes and on page load
document.addEventListener('DOMContentLoaded', function() {
  const symbolInput = document.getElementById('symbol-input');
  if (symbolInput) {
    symbolInput.addEventListener('change', function() {
      // console.log(`🔄 Symbol changed to: "${symbolInput.value.trim()}"`);
      debouncedLoadExpirations();
      
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
  
  // Debug: Show all localStorage keys
  console.log('🔍 localStorage contents on page load:');
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('selectedExpiration_')) {
      console.log(`  ${key}: ${localStorage.getItem(key)}`);
    }
  });
  
  if (symbolInput && dropdown && symbolInput.value.trim() && dropdown.options.length === 1) {
    console.log('🔄 Fallback: Loading expirations after window load');
    setTimeout(() => {
      loadExpirations();
    }, 1000);
  }
  
  // Update connection button visibility on page load
  updateConnectionButtonVisibility();
});

// Export functions for use in other files (global approach)
window.loadExpirations = loadExpirations;
window.debouncedLoadExpirations = debouncedLoadExpirations;
window.updateExpirationDate = updateExpirationDate;
window.saveSelectedExpiration = saveSelectedExpiration;
window.getSavedExpiration = getSavedExpiration;
window.clearSavedExpiration = clearSavedExpiration;
window.clearAllSavedExpirations = clearAllSavedExpirations;

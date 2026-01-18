// Global variables to store the full option data
let fullOptionArray = []; // Stores the original, uncombined options in the order they were entered
let combinedOptionMap = new Map(); // Stores the combined options for chart rendering
let fullCost = 0;
let fullMinStrike = 0;
let fullMaxStrike = 0;
let fullStrikeIncrement = 0;

// Function to update the chart based on slider value
function updateChartWithSlider() {
  const slider = document.getElementById('optionRange');
  const count = parseInt(slider.value);
  document.getElementById('optionCount').textContent = count;
  
  // Get a subset of the original options based on the slider value
  const visibleOptions = fullOptionArray.slice(0, count);
  
  // Create a map to combine the visible options for chart rendering
  const visibleCombinedMap = new Map();
  
  visibleOptions.forEach(option => {
    // Only process real options, not standalone cost adjustments
    if (option.type && option.strike !== null) {
      const key = `${option.type}${option.strike}`;
      if (visibleCombinedMap.has(key)) {
        visibleCombinedMap.get(key).qty += option.qty;
      } else {
        visibleCombinedMap.set(key, { ...option });
      }
    }
  });
  
  const visibleCombinedOptions = Array.from(visibleCombinedMap.values());
  
  // Calculate portfolio values with the filtered and combined options
  const data = calculatePortfolioValueAtExpiration(
    visibleCombinedOptions,
    fullMinStrike,
    fullMaxStrike,
    fullStrikeIncrement
  );
  
  // Draw the chart with the filtered data but show all original positions in the labels
  drawChart(data, fullCost, visibleOptions);
}

// Function to show all options
function showAllOptions() {
  const slider = document.getElementById('optionRange');
  slider.value = fullOptionArray.length;
  document.getElementById('optionCount').textContent = fullOptionArray.length;
  updateChartWithSlider();
}

// Initialize slider event listeners
function initSlider() {
  const slider = document.getElementById('optionRange');
  const showAllBtn = document.getElementById('showAllBtn');
  
  if (slider) {
    slider.addEventListener('input', updateChartWithSlider);
  }
  
  if (showAllBtn) {
    showAllBtn.addEventListener('click', showAllOptions);
  }
}

// Initialize slider when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  initSlider();
  
  // Load saved input if it exists
  const savedInput = localStorage.getItem('savedOptionInput');
  if (savedInput) {
    document.getElementById('textInput').value = savedInput;
  }
});

// Process input from the text input field
function processInput() {
  const inputText = document.getElementById('textInput').value;
  const outputDiv = document.getElementById('output');
  
  // Clear previous output
  outputDiv.innerHTML = '';
  
  // Store the input in local storage
  localStorage.setItem('savedOptionInput', inputText);

  try {
    // Clean the input text by removing newlines and other whitespace that could break JSON parsing
    const cleanInputText = inputText
      .replace(/\r\n|\r|\n/g, '')  // Remove all newline characters
      .replace(/\s+/g, ' ')      // Replace multiple spaces with a single space
      .trim();                    // Trim leading/trailing spaces
      
    const processedJSON = JSON.parse(cleanInputText);
    console.log(processedJSON);
    
    // Process options array, combining quantities for same type and strike
    const optionMap = new Map();
    
    // Helper function to process a single option string
    const processOptionString = (str) => {
      // Check for standalone cost adjustment
      const costMatch = str.match(/^@([+-]?\d+(?:\.\d+)?)$/i);
      if (costMatch) {
        return {
          qty: 0,
          type: null,
          strike: null,
          costAdjustment: parseFloat(costMatch[1])
        };
      }
      
      // Check for option with optional cost adjustment
      const match = str.match(/^([+-]?\d+)([cp])(\d+)(?:@([+-]?\d+(?:\.\d+)?))?$/i);
      if (!match) {
        throw new Error(`Invalid option format: ${str}. Expected format like 1c100, -1p110, 1c100@2000, or @2000`);
      }
      return {
        qty: parseInt(match[1], 10),
        type: match[2].toLowerCase(),
        strike: parseFloat(match[3]),
        costAdjustment: match[4] ? parseFloat(match[4]) : 0
      };
    };
    
    // Process the input based on its type
    let totalCostAdjustment = 0;
    
    if (typeof processedJSON.optionArray === 'string') {
      // Handle comma-separated string format
      processedJSON.optionArray
        .split(',')
        .map(optionStr => optionStr.trim())
        .filter(optionStr => optionStr)
        .forEach(optionStr => {
          const option = processOptionString(optionStr);
          totalCostAdjustment += option.costAdjustment;
          
          // Only add to optionMap if it's a real option (not standalone cost adjustment)
          if (option.qty !== 0 && option.type && option.strike !== null) {
            const key = `${option.type}${option.strike}`;
            if (optionMap.has(key)) {
              optionMap.get(key).qty += option.qty;
            } else {
              optionMap.set(key, { ...option });
            }
          }
        });
    } else if (Array.isArray(processedJSON.optionArray)) {
      // Handle array format (strings or objects)
      processedJSON.optionArray.forEach(option => {
        let processedOption;
        
        if (typeof option === 'string') {
          processedOption = processOptionString(option.trim());
          totalCostAdjustment += processedOption.costAdjustment;
        } else if (typeof option === 'object' && option !== null) {
          processedOption = {
            qty: typeof option.qty === 'string' ? 
              parseInt(option.qty.trim(), 10) : (option.qty || 1),
            type: option.type?.toString()?.toLowerCase()?.trim(),
            strike: typeof option.strike === 'string' ? 
              parseFloat(option.strike.trim()) : option.strike,
            costAdjustment: option.costAdjustment ? parseFloat(option.costAdjustment) : 0
          };
          totalCostAdjustment += processedOption.costAdjustment;
          
          // Validate the processed option (skip validation for standalone cost adjustments)
          if (processedOption.type && (!['c', 'p'].includes(processedOption.type) || 
              isNaN(processedOption.strike))) {
            throw new Error(`Invalid option object: ${JSON.stringify(option)}`);
          }
        } else {
          throw new Error(`Invalid option format: ${JSON.stringify(option)}`);
        }
        
        // Only add to optionMap if it's a real option (not standalone cost adjustment)
        if (processedOption.qty !== 0 && processedOption.type && processedOption.strike !== null) {
          const key = `${processedOption.type}${processedOption.strike}`;
          if (optionMap.has(key)) {
            optionMap.get(key).qty += processedOption.qty;
          } else {
            optionMap.set(key, processedOption);
          }
        }
      });
    } else {
      throw new Error('optionArray must be either a string or an array');
    }
    
    // Convert map to array and filter out zero quantities
    const combinedOptions = Array.from(optionMap.values())
      .filter(opt => opt.qty !== 0);
      
    if (combinedOptions.length === 0) {
      throw new Error('No valid options provided in optionArray');
    }

    // Store the combined options for chart rendering
    combinedOptionMap = new Map(combinedOptions.map(opt => [`${opt.type}${opt.strike}`, { ...opt }]));
    
    // Store the original uncombined options in the order they were entered
    fullOptionArray = [];
    if (typeof processedJSON.optionArray === 'string') {
      fullOptionArray = processedJSON.optionArray
        .split(',')
        .map(optionStr => optionStr.trim())
        .filter(optionStr => optionStr)
        .map(optionStr => processOptionString(optionStr));
    } else if (Array.isArray(processedJSON.optionArray)) {
      processedJSON.optionArray.forEach(option => {
        if (typeof option === 'string') {
          fullOptionArray.push(processOptionString(option.trim()));
        } else if (typeof option === 'object' && option !== null) {
          fullOptionArray.push({
            qty: typeof option.qty === 'string' ? 
              parseInt(option.qty.trim(), 10) : (option.qty || 1),
            type: option.type?.toString()?.toLowerCase()?.trim(),
            strike: typeof option.strike === 'string' ? 
              parseFloat(option.strike.trim()) : option.strike
          });
        }
      });
    }
    
    // Process tempOptionArray if it exists
    let tempOptionArray = [];
    if (processedJSON.tempOptionArray) {
      if (typeof processedJSON.tempOptionArray === 'string') {
        tempOptionArray = processedJSON.tempOptionArray
          .split(',')
          .map(optionStr => optionStr.trim())
          .filter(optionStr => optionStr)
          .map(optionStr => processOptionString(optionStr));
      } else if (Array.isArray(processedJSON.tempOptionArray)) {
        processedJSON.tempOptionArray.forEach(option => {
          if (typeof option === 'string') {
            tempOptionArray.push(processOptionString(option.trim()));
          } else if (typeof option === 'object' && option !== null) {
            tempOptionArray.push({
              qty: typeof option.qty === 'string' ? 
                parseInt(option.qty.trim(), 10) : (option.qty || 1),
              type: option.type?.toString()?.toLowerCase()?.trim(),
              strike: typeof option.strike === 'string' ? 
                parseFloat(option.strike.trim()) : option.strike,
              costAdjustment: option.costAdjustment ? parseFloat(option.costAdjustment) : 0
            });
          }
        });
      }
    }
    
    fullCost = (processedJSON.cost || 0) + totalCostAdjustment;
    const rangeStr = processedJSON.range;
    if (rangeStr != null && typeof rangeStr !== 'string') {
      throw new Error('range must be a string like "500-1000"');
    }
    if (typeof rangeStr === 'string' && rangeStr.trim() !== '') {
      const rangeMatch = rangeStr.match(/^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (!rangeMatch) {
        throw new Error('Invalid range format. Expected "minStrike-maxStrike" (example: "500-1000")');
      }
      fullMinStrike = parseFloat(rangeMatch[1]);
      fullMaxStrike = parseFloat(rangeMatch[2]);
      if (!Number.isFinite(fullMinStrike) || !Number.isFinite(fullMaxStrike)) {
        throw new Error('Invalid range values. minStrike and maxStrike must be numbers.');
      }
      if (fullMinStrike >= fullMaxStrike) {
        throw new Error('Invalid range values. minStrike must be less than maxStrike.');
      }
    } else {
      const strikes = [];
      combinedOptions.forEach(opt => strikes.push(opt.strike));
      tempOptionArray.forEach(opt => strikes.push(opt.strike));

      const finiteStrikes = strikes.filter(s => Number.isFinite(s));
      if (finiteStrikes.length === 0) {
        throw new Error('Unable to infer range: no valid strikes found in optionArray/tempOptionArray');
      }

      const minStrikeProvided = Math.min(...finiteStrikes);
      const maxStrikeProvided = Math.max(...finiteStrikes);
      fullMinStrike = minStrikeProvided - 50;
      fullMaxStrike = maxStrikeProvided + 50;
    }
    fullStrikeIncrement = processedJSON.strikeIncrement || 10;

    // Initialize the slider
    const sliderContainer = document.getElementById('sliderContainer');
    const slider = document.getElementById('optionRange');
    
    if (fullOptionArray.length > 1) {
      // Show the slider if there are multiple options
      sliderContainer.style.display = 'block';
      slider.min = 1;
      slider.max = fullOptionArray.length;
      slider.value = fullOptionArray.length; // Default to showing all options
      document.getElementById('optionCount').textContent = fullOptionArray.length;
    } else {
      // Hide the slider if there's only one option
      sliderContainer.style.display = 'none';
    }
    
    // Calculate and display the portfolio values with all options combined
    const data = calculatePortfolioValueAtExpiration(
      combinedOptions,
      fullMinStrike,
      fullMaxStrike,
      processedJSON.strikeIncrement || 10
    );
    
    // Calculate the combined portfolio values (optionArray + tempOptionArray)
    let combinedData = [];
    if (tempOptionArray.length > 0) {
      // Create a map of all options (from both arrays)
      const allOptionsMap = new Map();
      
      // First add all options from the main optionArray
      combinedOptions.forEach(option => {
        const key = `${option.type}${option.strike}`;
        allOptionsMap.set(key, { ...option });
      });
      
      // Then add or combine with options from tempOptionArray
      tempOptionArray.forEach(option => {
        const key = `${option.type}${option.strike}`;
        if (allOptionsMap.has(key)) {
          allOptionsMap.get(key).qty += option.qty;
        } else {
          allOptionsMap.set(key, { ...option });
        }
      });
      
      const allOptions = Array.from(allOptionsMap.values());
      
      // Calculate portfolio values for the combined options
      combinedData = calculatePortfolioValueAtExpiration(
        allOptions,
        fullMinStrike,
        fullMaxStrike,
        processedJSON.strikeIncrement || 10
      );
    }
    
    // Draw the chart with both datasets if there's combined data, otherwise just the main data
    if (combinedData.length > 0) {
      drawChart(data, fullCost, fullOptionArray, combinedData);
    } else {
      drawChart(data, fullCost, fullOptionArray);
    }
    
    // Display the processed output
    const formatCurve = (curve) => curve
      .map(p => {
        const diff = p.totalIntrinsicValue - fullCost;
        const diffStr = diff >= 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2);
        return `${p.closingPrice}: ${p.totalIntrinsicValue} (${diffStr})`;
      })
      .join('\n');

    // Find key points on the main curve
    const keyPoints = findKeyPointsOnCurve(data, fullCost);
    const formatKeyPoints = (points) => points
      .map(p => `${p.description}: $${p.closingPrice.toFixed(2)} (Value: $${p.totalIntrinsicValue.toFixed(2)})`)
      .join('\n');

    let outputStr = `
      <strong>Processed Output:</strong><br>
      <strong>Position Count:</strong> ${fullOptionArray.length}<br>
      <strong>Total Cost:</strong> $${fullCost.toFixed(2)}<br><br>
      <strong>Value Curve (optionArray):</strong><br>
      <pre>${formatCurve(data)}</pre>
    `;

    if (keyPoints.length > 0) {
      outputStr += `
        <strong>Key Points on Curve:</strong><br>
        <pre>${formatKeyPoints(keyPoints)}</pre>
      `;
    }

    if (combinedData.length > 0) {
      outputStr += `
        <strong>Value Curve (optionArray + tempOptionArray):</strong><br>
        <pre>${formatCurve(combinedData)}</pre>
      `;
      
      // Find key points on combined curve as well
      const combinedKeyPoints = findKeyPointsOnCurve(combinedData, fullCost);
      if (combinedKeyPoints.length > 0) {
        outputStr += `
          <strong>Key Points on Combined Curve:</strong><br>
          <pre>${formatKeyPoints(combinedKeyPoints)}</pre>
        `;
      }
    }

    outputDiv.innerHTML = outputStr;
    
  } catch (error) {
    console.error('Error processing input:', error);
    outputDiv.innerHTML = `
      <strong>Error:</strong> ${error.message}<br><br>
      <strong>Expected format:</strong><br>
      <pre>{
  "cost": 20000,
  "range": "500-1000",
  "strikeIncrement": 10,
  "optionArray": "
1c620,-1c820,@2000,
1c620,-1c800,@-1000,
1p960,-1p800,
",
"tempOptionArray": "
1c650,-1c750,
"
}</pre>
      Or as a comma-separated string in the optionArray: <code>"1c22720,1c22740,1p22860,1p22820"</code>
    `;
  }
}

/**
 * Identifies key points on the value curve including low points, zero crossings, and high points/peaks
 * @param {Array<object>} valueCurve - Array of objects with closingPrice and totalIntrinsicValue
 * @param {number} cost - The total cost of the position
 * @returns {Array<object>} Array of key points with type and value information
 */
function findKeyPointsOnCurve(valueCurve, cost) {
    if (!Array.isArray(valueCurve) || valueCurve.length < 3) {
        return [];
    }
    
    const keyPoints = [];
    
    // Find zero crossings (where profit/loss changes sign)
    for (let i = 0; i < valueCurve.length - 1; i++) {
        const current = valueCurve[i];
        const next = valueCurve[i + 1];
        
        const currentProfitLoss = current.totalIntrinsicValue - cost;
        const nextProfitLoss = next.totalIntrinsicValue - cost;
        
        // Check for zero crossing (sign change in profit/loss)
        if ((currentProfitLoss <= 0 && nextProfitLoss >= 0) ||
            (currentProfitLoss >= 0 && nextProfitLoss <= 0)) {
            
            // Linear interpolation to find exact crossing point
            if (currentProfitLoss !== nextProfitLoss) {
                const ratio = Math.abs(currentProfitLoss) / 
                             Math.abs(nextProfitLoss - currentProfitLoss);
                const crossingPrice = current.closingPrice + 
                                    (next.closingPrice - current.closingPrice) * ratio;
                
                keyPoints.push({
                    type: 'zero_crossing',
                    closingPrice: crossingPrice,
                    totalIntrinsicValue: cost, // At zero crossing, intrinsic value equals cost
                    description: 'Break Even'
                });
            }
        }
    }
    
    // Find local minima (low points) and maxima (high points) - only at direction changes
    let trend = null; // 'up', 'down', or null
    let lastNonFlatPoint = null;
    
    for (let i = 1; i < valueCurve.length; i++) {
        const prev = valueCurve[i - 1];
        const current = valueCurve[i];
        
        const currentDiff = current.totalIntrinsicValue - prev.totalIntrinsicValue;
        const currentTrend = currentDiff > 0 ? 'up' : (currentDiff < 0 ? 'down' : null);
        
        // Check for trend change
        if (trend !== null && currentTrend !== null && currentTrend !== trend) {
            // Trend changed, previous point was a turning point
            const turningPoint = valueCurve[i - 1];
            
            if (trend === 'down' && currentTrend === 'up') {
                // Was going down, now going up - this is a low point
                keyPoints.push({
                    type: 'low_point',
                    closingPrice: turningPoint.closingPrice,
                    totalIntrinsicValue: turningPoint.totalIntrinsicValue,
                    description: 'Low Point'
                });
            } else if (trend === 'up' && currentTrend === 'down') {
                // Was going up, now going down - this is a high point
                keyPoints.push({
                    type: 'high_point',
                    closingPrice: turningPoint.closingPrice,
                    totalIntrinsicValue: turningPoint.totalIntrinsicValue,
                    description: 'High Point'
                });
            }
        }
        
        // Handle flat period ending and starting to trend
        if (trend === null && currentTrend !== null && lastNonFlatPoint !== null) {
            // Was flat, now trending - check if this is a turning point
            if (currentTrend === 'up') {
                // Flat period ended, now going up - the flat period was a low point
                keyPoints.push({
                    type: 'low_point',
                    closingPrice: lastNonFlatPoint.closingPrice,
                    totalIntrinsicValue: lastNonFlatPoint.totalIntrinsicValue,
                    description: 'Low Point'
                });
            } else if (currentTrend === 'down') {
                // Flat period ended, now going down - the flat period was a high point
                keyPoints.push({
                    type: 'high_point',
                    closingPrice: lastNonFlatPoint.closingPrice,
                    totalIntrinsicValue: lastNonFlatPoint.totalIntrinsicValue,
                    description: 'High Point'
                });
            }
        }
        
        // Update trend and track last non-flat point
        if (currentTrend !== null) {
            trend = currentTrend;
            lastNonFlatPoint = current;
        }
    }
    
    // Sort by closing price
    keyPoints.sort((a, b) => a.closingPrice - b.closingPrice);
    
    return keyPoints;
}

/**
 * Calculates the total intrinsic value at expiration for an array of options positions
 * across a range of underlying asset prices. This does NOT include the initial premium paid/received.
 *
 * @param {Array<object>} optionsPositions - An array of configuration objects for each option position.
 * @param {string} optionsPositions[].id - A unique identifier for the position (e.g., 'call1', 'put2').
 * @param {'c' | 'p'} optionsPositions[].type - The type of option ('c' for call or 'p' for put).
 * @param {number} optionsPositions[].strike - The strike price of the option.
 * @param {number} [optionsPositions[].qty=1] - The number of contracts for this specific position (positive for long, negative for short).
 * @param {number} [optionsPositions[].contractMultiplier=100] - The number of shares per contract (default is 100).
 * @param {number} minPrice - The minimum closing price to evaluate.
 * @param {number} maxPrice - The maximum closing price to evaluate.
 * @param {number} priceStep - The increment for each price point in the range.
 * @returns {Array<object>} An array of objects, each with 'closingPrice' and 'totalIntrinsicValue'.
 */
function calculatePortfolioValueAtExpiration(optionsPositions, minPrice, maxPrice, priceStep) {
    if (!Array.isArray(optionsPositions) || optionsPositions.length === 0) {
        throw new Error("optionsPositions must be a non-empty array of option configurations.");
    }
    if (minPrice >= maxPrice) {
        throw new Error("minPrice must be less than maxPrice.");
    }
    if (priceStep <= 0) {
        throw new Error("priceStep must be a positive number.");
    }
  
    const valueCurve = [];
  
    for (let closingPrice = minPrice; closingPrice <= maxPrice; closingPrice += priceStep) {
        let portfolioTotalIntrinsicValue = 0;
  
        for (const optionConfig of optionsPositions) {
            const {
                type,
                strike,
                qty = 1,
                contractMultiplier = 100
            } = optionConfig;
  
            // Basic validation for each individual option config
            if (!['c', 'p'].includes(type)) {
                throw new Error(`Invalid option type '${type}' for position ID: ${optionConfig.id}`);
            }
            if (strike <= 0 || qty === 0) {
                throw new Error(`Invalid strike (${strike}) or quantity (${qty}) for position ID: ${optionConfig.id}`);
            }
  
            let intrinsicValuePerShare = 0;
  
            // Calculate intrinsic value per share for the current option leg
            if (type === 'c') {
                intrinsicValuePerShare = Math.max(0, closingPrice - strike);
            } else { // type === 'p'
                intrinsicValuePerShare = Math.max(0, strike - closingPrice);
            }
  
            // The value to the holder depends on whether they are long (positive qty) or short (negative qty).
            // A long position gains value when the option is ITM.
            // A short position loses value when the option is ITM (negative value to the short holder).
            let legValue = intrinsicValuePerShare * contractMultiplier * qty;
  
            portfolioTotalIntrinsicValue += legValue;
        }
  
        valueCurve.push({
            closingPrice: parseFloat(closingPrice.toFixed(2)),
            totalIntrinsicValue: parseFloat(portfolioTotalIntrinsicValue.toFixed(2))
        });
    }
  
    return valueCurve;
}





function drawChart(data, cost, optionArray = [], tempData = []) {
    // Clear previous chart
    d3.select("#chart").selectAll("*").remove();
    
    // Find key points for main curve
    const keyPoints = findKeyPointsOnCurve(data, cost);
    
    // Find key points for temp curve if it exists
    const tempKeyPoints = tempData.length > 0 ? findKeyPointsOnCurve(tempData, cost) : [];
    
    const margin = { top: 30, right: 30, bottom: 60, left: 60 };
    const width = document.getElementById('chart').offsetWidth - margin.left - margin.right;
    const height = document.getElementById('chart').offsetHeight - margin.top - margin.bottom;

    const svg = d3.select("#chart")
        .append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Calculate the min and max of totalIntrinsicValue from data
    const minIntrinsicValue = d3.min(data, d => d.totalIntrinsicValue);
    const maxIntrinsicValue = d3.max(data, d => d.totalIntrinsicValue);

    // Determine the overall min and max for the Y-axis domain, including the cost
    const overallMinY = Math.min(minIntrinsicValue, cost);
    const overallMaxY = Math.max(maxIntrinsicValue, cost);
    
    // Calculate 10% of the range for padding
    const yRange = overallMaxY - overallMinY;
    const yPadding = yRange * 0.2;

    // Set up scales
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d.closingPrice))
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain([overallMinY - yPadding, overallMaxY + yPadding])
        .range([height, 0]);

    // Add X axis
    svg.append("g")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(xScale))
        .append("text")
        .attr("y", 40)
        .attr("x", width / 2)
        .attr("fill", "black")
        .attr("text-anchor", "middle")
        .text("Closing Price ($)");

    // Add Y axis
    svg.append("g")
        .call(d3.axisLeft(yScale))
        .append("text")
        .attr("transform", "rotate(-90)")
        .attr("y", -40)
        .attr("x", -height / 2)
        .attr("fill", "black")
        .attr("text-anchor", "middle")
        .text("Total Intrinsic Value ($)");

    // Add the line for main option values
    const line = d3.line()
        .x(d => xScale(d.closingPrice))
        .y(d => yScale(d.totalIntrinsicValue));

    // Draw main portfolio line
    svg.append("path")
        .datum(data)
        .attr("fill", "none")
        .attr("stroke", "steelblue")
        .attr("stroke-width", 1.5)
        .attr("d", line);
        
    // Draw temp portfolio line if data exists
    if (tempData.length > 0) {
      svg.append("path")
          .datum(tempData)
          .attr("fill", "none")
          .attr("stroke", "#88c9ff")  // Lighter blue
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "3,3")  // Dotted line
          .attr("d", line);
    }

    // Add a horizontal line for the cost
    svg.append("line")
        .attr("x1", xScale(d3.min(data, d => d.closingPrice)))
        .attr("y1", yScale(cost))
        .attr("x2", xScale(d3.max(data, d => d.closingPrice)))
        .attr("y2", yScale(cost))
        .attr("stroke", "red")
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "3, 3");

    // Add a group for the interactive elements
    const interactionGroup = svg.append("g");

    // Add circles for each option in the optionArray
    if (optionArray && optionArray.length > 0) {
      // Filter out standalone cost adjustments (where type is null or qty is 0)
      const realOptions = optionArray.filter(option => option.type && option.strike !== null && option.qty !== 0);
      
      // First, group the options by strike and type
      const groupedOptions = realOptions.reduce((acc, option) => {
        const key = `${option.type}${option.strike}`;
        if (!acc[key]) {
          acc[key] = {
            type: option.type,
            strike: option.strike,
            qty: 0,
            elements: []
          };
        }
        acc[key].qty += option.qty;
        acc[key].elements.push(option);
        return acc;
      }, {});

      // Convert the grouped options to an array
      const uniqueOptions = Object.values(groupedOptions);

      // Create circles for each unique option group
      const optionCircles = svg.append("g")
          .selectAll(".option-circle")
          .data(uniqueOptions)
          .enter()
          .append("g")
          .attr("class", "option-circle")
          .attr("transform", d => {
            let yPos = 0; // Default y position; calls
            if (d.type === 'p') yPos = -10; // Move up for puts
            return `translate(${xScale(d.strike)}, ${yPos})`;
          });

      // Add the circle
      optionCircles.append("circle")
          .attr("r", 7) // Slightly larger to fit quantity
          .attr("fill", d => d.qty >= 0 ? '#4CAF50' : '#F44336') // Green for positive, red for neg
          .attr("stroke", "white")
          .attr("stroke-width", 1.5);

      // Add the text (qty + type, e.g. "2C")
      optionCircles.append("text")
          .attr("text-anchor", "middle")
          .attr("dy", ".35em")
          .attr("fill", "white")
          .style("font-weight", "bold")
          .style("font-size", "8px")
          .text(d => `${Math.abs(d.qty)}${d.type.toUpperCase()}`);

      // Add strike price - position based on option type
      optionCircles.each(function(d) {
        const isLong = d.qty >= 0;
        const isPuts = d.type === 'p';
        d3.select(this).append("text")
            .attr("y", isPuts ? -9 : 16) // Above for calls, below for puts
            .attr("text-anchor", "middle")
            .style("font-size", "10px")
            .style("fill", "#333")
            .style("font-weight", "500")
            .text(d.strike);
      });
    }

    // Function to handle both touch and mouse events
    function handlePointerEvent(event) {
        event.preventDefault(); // Prevent default touch behavior
        const touch = event.type.includes('touch') ? event.changedTouches[0] : event;
        const [xCoord] = d3.pointer(touch, this);
        
        // Remove any existing vertical line and label
        interactionGroup.selectAll(".vertical-line, .chart-label, .chart-label-bg").remove();
        
        // Find the closest data point to the x-coordinate
        const bisectDate = d3.bisector(d => d.closingPrice).left;
        const x0 = xScale.invert(xCoord);
        const i = bisectDate(data, x0, 1);
        const d0 = data[i - 1];
        const d1 = data[i];
        const d = x0 - d0.closingPrice > d1.closingPrice - x0 ? d1 : d0;
        
        // Add vertical line
        interactionGroup.append("line")
            .attr("class", "vertical-line")
            .attr("x1", xScale(d.closingPrice))
            .attr("y1", yScale.range()[0])
            .attr("x2", xScale(d.closingPrice))
            .attr("y2", yScale.range()[1]);
        
        // Add text label with background
        const profitLoss = d.totalIntrinsicValue - cost;
        const profitLossText = profitLoss >= 0 ? `+$${profitLoss.toFixed(2)}` : `-$${Math.abs(profitLoss).toFixed(2)}`;
        const profitLossColor = profitLoss >= 0 ? '#4CAF50' : '#F44336';
        
        const labelText = `$${d.totalIntrinsicValue.toFixed(2)}\n${profitLossText}`;
        const labelX = xScale(d.closingPrice);
        const labelY = yScale(d.totalIntrinsicValue) - 10;
        
        // Add background rectangle first
        const textElement = interactionGroup.append("text")
            .attr("class", "chart-label")
            .attr("x", labelX)
            .attr("y", labelY)
            .attr("text-anchor", "middle")
            .attr("alignment-baseline", "middle")
            .text(labelText);
        
        // Add profit/loss styling with tspan
        const lines = labelText.split('\n');
        textElement.text(''); // Clear the text
        
        lines.forEach((line, index) => {
          const tspan = textElement.append("tspan")
              .attr("x", labelX)
              .attr("dy", index === 0 ? "0" : "1.2em")
              .text(line);
          
          if (index === 1) {
            tspan.attr("fill", profitLossColor).attr("font-size", "12px");
          }
        });
        
        // Get the bounding box of the text
        const bbox = textElement.node().getBBox();
        
        // Add the background
        interactionGroup.insert("rect", "text")
            .attr("class", "chart-label-bg")
            .attr("x", bbox.x - 2)
            .attr("y", bbox.y - 2)
            .attr("width", bbox.width + 4)
            .attr("height", bbox.height + 4);
    }

    // Add key points markers for main curve
    if (keyPoints.length > 0) {
        const keyPointMarkers = svg.append("g")
            .selectAll(".key-point")
            .data(keyPoints)
            .enter()
            .append("g")
            .attr("class", "key-point");

        // Add markers based on type
        keyPointMarkers.append("path")
            .attr("d", d => {
                const x = xScale(d.closingPrice);
                const y = yScale(d.totalIntrinsicValue);
                
                if (d.type === 'low_point') {
                    // Green triangle pointing up (in SVG coordinates, this means negative Y offset)
                    return `M ${x},${y - 8} L ${x - 6},${y + 4} L ${x + 6},${y + 4} Z`;
                } else if (d.type === 'high_point') {
                    // Red triangle pointing down (in SVG coordinates, this means positive Y offset)
                    return `M ${x},${y + 8} L ${x - 6},${y - 4} L ${x + 6},${y - 4} Z`;
                } else if (d.type === 'zero_crossing') {
                    // Gray circle
                    return `M ${x + 6},${y} A 6,6 0 0,0 ${x - 6},${y} A 6,6 0 0,0 ${x + 6},${y} Z`;
                }
                return '';
            })
            .attr("fill", d => {
                if (d.type === 'low_point') return '#4CAF50';
                if (d.type === 'high_point') return '#F44336';
                if (d.type === 'zero_crossing') return '#808080';
                return '#666';
            })
            .attr("stroke", "white")
            .attr("stroke-width", 1);

        // Add labels for key points
        keyPointMarkers.append("text")
            .attr("x", d => xScale(d.closingPrice))
            .attr("y", d => {
                const y = yScale(d.totalIntrinsicValue);
                if (d.type === 'low_point') return y + 15;
                if (d.type === 'high_point') return y - 15;
                if (d.type === 'zero_crossing') return y - 12;
                return y;
            })
            .attr("text-anchor", "middle")
            .attr("font-size", "11px")
            .attr("font-weight", "bold")
            .attr("fill", "#333")
            .text(d => `$${d.closingPrice.toFixed(0)}`);
    }

    // Add key points markers for temp curve if it exists
    if (tempKeyPoints.length > 0) {
        const tempKeyPointMarkers = svg.append("g")
            .selectAll(".temp-key-point")
            .data(tempKeyPoints)
            .enter()
            .append("g")
            .attr("class", "temp-key-point");

        // Add markers for temp curve (lighter colors)
        tempKeyPointMarkers.append("path")
            .attr("d", d => {
                const x = xScale(d.closingPrice);
                const y = yScale(d.totalIntrinsicValue);
                
                if (d.type === 'low_point') {
                    // Light green triangle pointing up (in SVG coordinates, this means negative Y offset)
                    return `M ${x},${y - 8} L ${x - 6},${y + 4} L ${x + 6},${y + 4} Z`;
                } else if (d.type === 'high_point') {
                    // Light red triangle pointing down (in SVG coordinates, this means positive Y offset)
                    return `M ${x},${y + 8} L ${x - 6},${y - 4} L ${x + 6},${y - 4} Z`;
                } else if (d.type === 'zero_crossing') {
                    // Light gray circle
                    return `M ${x + 6},${y} A 6,6 0 0,0 ${x - 6},${y} A 6,6 0 0,0 ${x + 6},${y} Z`;
                }
                return '';
            })
            .attr("fill", d => {
                if (d.type === 'low_point') return '#81C784';
                if (d.type === 'high_point') return '#EF9A9A';
                if (d.type === 'zero_crossing') return '#A0A0A0';
                return '#999';
            })
            .attr("stroke", "white")
            .attr("stroke-width", 1)
            .attr("opacity", 0.8);

        // Add labels for temp key points
        tempKeyPointMarkers.append("text")
            .attr("x", d => xScale(d.closingPrice))
            .attr("y", d => {
                const y = yScale(d.totalIntrinsicValue);
                if (d.type === 'low_point') return y + 15;
                if (d.type === 'high_point') return y - 15;
                if (d.type === 'zero_crossing') return y - 12;
                return y;
            })
            .attr("text-anchor", "middle")
            .attr("font-size", "11px")
            .attr("font-weight", "bold")
            .attr("fill", "#333")
            .text(d => `$${d.closingPrice.toFixed(0)}`);
    }

    // Add event listeners for both mouse and touch events
    svg.on("click", handlePointerEvent)
       .on("touchstart", handlePointerEvent)
       .on("touchmove", handlePointerEvent);
}


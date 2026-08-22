// Chart Module - Contains all charting functionality

// calculatePortfolioValueAtExpiration now lives in shared/portfolio-risk.js so
// server-side code can reuse the identical math for aggregate risk analysis —
// see PortfolioRisk.analyzePortfolioRisk / findPortfolioHedgeCandidates.
const calculatePortfolioValueAtExpiration = PortfolioRisk.calculatePortfolioValueAtExpiration;

// Remembered across redraws so the chart can be re-rendered when only the live
// underlying price changes (redrawWithPrice), and so a click info box the user
// opened is re-applied after each redraw rather than lost.
let lastChartArgs = null;
let lastClickedPrice = null; // the underlying price of the last chart click

/**
 * Find key points on the value curve: local lows, highs, and break-even points.
 * @param {Array<object>} valueCurve - Array of objects with closingPrice and totalIntrinsicValue
 * @param {number} cost - The total cost of the position
 * @returns {Array<object>} Array of key points with type and value information
 */
function findKeyPointsOnCurve(valueCurve, cost) {
    if (!Array.isArray(valueCurve) || valueCurve.length < 2) {
        return [];
    }

    const n = valueCurve.length;
    // P/L at each sampled point. Slopes between points are cost-independent (the
    // cost cancels), so up/down/flat classification is exact to the cent.
    const V = valueCurve.map(p => p.totalIntrinsicValue - cost);
    const keyPoints = [];

    const pushPoint = (type, description, idx) => {
        keyPoints.push({
            type,
            closingPrice: valueCurve[idx].closingPrice,
            totalIntrinsicValue: valueCurve[idx].totalIntrinsicValue,
            description
        });
    };

    // --- Break-even points: where the P/L curve reaches zero ---
    // Points sitting exactly on zero (a touch or an on-sample crossing).
    for (let i = 0; i < n; i++) {
        if (V[i] === 0) pushPoint('zero_crossing', 'Break-even', i);
    }
    // Strict sign changes between neighbors (neither endpoint exactly zero):
    // interpolate the exact price where P/L = 0 (payoff is linear between samples).
    for (let g = 0; g < n - 1; g++) {
        const a = V[g], b = V[g + 1];
        if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
            const t = -a / (b - a); // fraction from g to g+1 where P/L hits 0
            const price = valueCurve[g].closingPrice +
                t * (valueCurve[g + 1].closingPrice - valueCurve[g].closingPrice);
            keyPoints.push({
                type: 'zero_crossing',
                closingPrice: price,
                totalIntrinsicValue: cost, // P/L = 0 here
                description: 'Break-even'
            });
        }
    }

    // --- Slope runs, for extrema detection with plateau handling ---
    // Collapse consecutive gaps of the same direction into segments spanning a
    // range of point indices. Adjacent segments always differ in direction.
    const segments = [];
    let g = 0;
    while (g < n - 1) {
        const dir = Math.sign(valueCurve[g + 1].totalIntrinsicValue - valueCurve[g].totalIntrinsicValue);
        const startPt = g;
        while (g < n - 1 &&
               Math.sign(valueCurve[g + 1].totalIntrinsicValue - valueCurve[g].totalIntrinsicValue) === dir) {
            g++;
        }
        segments.push({ dir, startPt, endPt: g });
    }

    // Sharp corners (no plateau): an up-run meeting a down-run is a peak — a down
    // arrow ▼ (local top); a down-run meeting an up-run is a valley — an up arrow
    // ▲ (local bottom). The shared point is the corner.
    for (let k = 0; k < segments.length - 1; k++) {
        const a = segments[k], b = segments[k + 1];
        if (a.dir === 1 && b.dir === -1) pushPoint('down_arrow', 'High point', a.endPt);
        else if (a.dir === -1 && b.dir === 1) pushPoint('up_arrow', 'Low point', a.endPt);
    }

    // Plateau corners. Each corner is marked from the slope on its NON-flat side,
    // by whether that neighbor sits below the plateau (a local top → down arrow ▼)
    // or above it (a local bottom → up arrow ▲):
    //   left corner  — rose INTO the plateau (neighbor below) → ↓ ; fell in → ↑
    //   right corner — rises AWAY from it (neighbor above)    → ↑ ; falls away → ↓
    // So a peak plateau reads ↓ ↓, a valley ↑ ↑, a rising step ↓ then ↑, a falling
    // step ↑ then ↓. Edge plateaus only mark their interior (sloped) corner.
    for (let k = 0; k < segments.length; k++) {
        const seg = segments[k];
        if (seg.dir !== 0) continue;
        const prevDir = k > 0 ? segments[k - 1].dir : null;
        const nextDir = k < segments.length - 1 ? segments[k + 1].dir : null;

        if (prevDir === 1) pushPoint('down_arrow', 'High point', seg.startPt);
        else if (prevDir === -1) pushPoint('up_arrow', 'Low point', seg.startPt);

        if (nextDir === 1) pushPoint('up_arrow', 'Low point', seg.endPt);
        else if (nextDir === -1) pushPoint('down_arrow', 'High point', seg.endPt);
    }

    // --- Sloping endpoints kept as reference. A still-rising/falling tail isn't a
    // true extremum, but marks where the sampled window ends. Flat edges are
    // already handled above as caps/floors, so only sloping edges get a marker. ---
    if (segments.length > 0) {
        if (segments[0].dir !== 0) pushPoint('curve_endpoint', 'Curve Start', 0);
        if (segments[segments.length - 1].dir !== 0) pushPoint('curve_endpoint', 'Curve End', n - 1);
    }

    // Left-to-right by price; drop consecutive duplicates of the same type/price.
    keyPoints.sort((p, q) => p.closingPrice - q.closingPrice);
    const deduped = [];
    keyPoints.forEach(p => {
        const last = deduped[deduped.length - 1];
        if (!last || last.type !== p.type || Math.abs(last.closingPrice - p.closingPrice) > 1e-9) {
            deduped.push(p);
        }
    });
    return deduped;
}

/**
 * Draw the chart with portfolio value data
 * @param {Array} data - Main portfolio data
 * @param {number} cost - Cost of the portfolio
 * @param {Array} optionArray - Array of options to display as circles
 * @param {Array} tempData - Optional temporary data for comparison
 * @param {number} underlyingPrice - Current underlying price for vertical line
 * @param {number} combinedCost - Optional combined cost (main + temp positions)
 */
function drawChart(data, cost, optionArray = [], tempData = [], underlyingPrice = null, combinedCost = null) {
    // Remember these so redrawWithPrice() can re-render with only the price changed.
    lastChartArgs = { data, cost, optionArray, tempData, underlyingPrice, combinedCost };

    // Clear previous chart
    d3.select("#chart").selectAll("*").remove();
    
    // Find key points for main curve
    const keyPoints = findKeyPointsOnCurve(data, cost);
    
    // Find key points for temp curve if it exists
    const tempKeyPoints = (tempData && tempData.length > 0) ? findKeyPointsOnCurve(tempData, cost) : [];
    
    const margin = { top: 30, right: 30, bottom: 60, left: 60 };
    const width = document.getElementById('chart').offsetWidth - margin.left - margin.right;
    const height = document.getElementById('chart').offsetHeight - margin.top - margin.bottom;

    const svg = d3.select("#chart")
        .append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Include the temp/comparison curve (when present) in the axis range so the scales
    // accommodate the FULL span of both the current position and the temp one — otherwise
    // the temp curve runs off-scale and is hard to read.
    const rangeData = (tempData && tempData.length > 0) ? data.concat(tempData) : data;

    // Calculate the min and max of totalIntrinsicValue across both curves
    const minIntrinsicValue = d3.min(rangeData, d => d.totalIntrinsicValue);
    const maxIntrinsicValue = d3.max(rangeData, d => d.totalIntrinsicValue);

    // Determine the overall min and max for the Y-axis domain, including the cost
    const overallMinY = Math.min(minIntrinsicValue, cost);
    const overallMaxY = Math.max(maxIntrinsicValue, cost);
    
    // Calculate 10% of the range for padding
    const yRange = overallMaxY - overallMinY;
    const yPadding = yRange * 0.1;

    // Create scales
    const xScale = d3.scaleLinear()
        .domain(d3.extent(rangeData, d => d.closingPrice))
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain([overallMinY - yPadding, overallMaxY + yPadding])
        .range([height, 0]);

    // Create line generator
    const line = d3.line()
        .x(d => xScale(d.closingPrice))
        .y(d => yScale(d.totalIntrinsicValue))
        .curve(d3.curveMonotoneX);

    // Add X axis with limited ticks to prevent overlap
    const maxTicks = Math.min(10, Math.floor(width / 50));
    console.log(`🎯 Chart width: ${width}, calculated max ticks: ${maxTicks}`);
    
    const xAxis = d3.axisBottom(xScale)
        .tickFormat(d3.format(".0f"))
        .ticks(maxTicks); // Dynamic tick calculation
    
    const xAxisGroup = svg.append("g")
        .attr("transform", `translate(0,${height})`)
        .call(xAxis);
    
    // Count actual ticks rendered
    const actualTicks = xAxisGroup.selectAll(".tick").size();
    console.log(`📊 Actual ticks rendered: ${actualTicks}`);
    
    // Optional: Rotate labels if still overlapping
    xAxisGroup.selectAll("text")
        //.style("text-anchor", "end")
        //.attr("dx", "-.8em")
        //.attr("dy", ".15em") 
        //.attr("transform", "rotate(-45)")
        .style("font-size", "11px");

    // Add Y axis
    svg.append("g")
        .call(d3.axisLeft(yScale).tickFormat(d3.format("$.0f")));

    // Add main portfolio line
    svg.append("path")
        .datum(data)
        .attr("fill", "none")
        .attr("stroke", "steelblue")
        .attr("stroke-width", 2)
        .attr("d", line);

    // Add temp portfolio line if it exists
    if (tempData && tempData.length > 0) {
        const tempLine = d3.line()
            .x(d => xScale(d.closingPrice))
            .y(d => yScale(d.totalIntrinsicValue))
            .curve(d3.curveMonotoneX);

        svg.append("path")
            .datum(tempData)
            .attr("fill", "none")
            .attr("stroke", "lightblue")
            .attr("stroke-width", 2)
            .attr("stroke-dasharray", "5,5")
            .attr("d", tempLine);
    }

    // Add a horizontal line for the main cost
    svg.append("line")
        .attr("x1", xScale(d3.min(data, d => d.closingPrice)))
        .attr("y1", yScale(cost))
        .attr("x2", xScale(d3.max(data, d => d.closingPrice)))
        .attr("y2", yScale(cost))
        .attr("stroke", "red")
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "3, 3");

    // Add a second horizontal line for the combined cost (if temp positions exist)
    if (combinedCost !== null && combinedCost !== cost) {
        svg.append("line")
            .attr("x1", xScale(d3.min(data, d => d.closingPrice)))
            .attr("y1", yScale(combinedCost))
            .attr("x2", xScale(d3.max(data, d => d.closingPrice)))
            .attr("y2", yScale(combinedCost))
            .attr("stroke", "green")
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "5, 5");
    }


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
            totalQty: 0,
            positions: []
          };
        }
        acc[key].totalQty += option.qty;
        acc[key].positions.push(option);
        return acc;
      }, {});

      // Convert to array and sort by strike
      const uniqueOptions = Object.values(groupedOptions).sort((a, b) => a.strike - b.strike);

      // Add circles for each unique option
      if (uniqueOptions.length > 0) {
        uniqueOptions.forEach(option => {
        const isLong = option.totalQty >= 0;
        const isPuts = option.type === 'p';
        
        svg.append("circle")
          .attr("cx", xScale(option.strike))
          .attr("cy", isPuts ? -16 : 8) // puts above
          .attr("r", 7)
          .attr("fill", isLong ? "#4CAF50" : "#F44336")
          .append("title")
          .text(`${option.totalQty > 0 ? 'Long' : 'Short'} ${option.totalQty} ${option.type.toUpperCase()} @ $${option.strike}`);

        // Add quantity label
        svg.append("text")
          .attr("x", xScale(option.strike))
          .attr("y", isPuts ? -15 : 9) // puts above
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "middle")
          .style("font-weight", "bold")
          .style("font-size", "8px")
          .style("fill", "#fff")
          .text(d => `${Math.abs(option.totalQty)}${option.type.toUpperCase()}`);

        // Add strike price - position based on option type
        svg.append("text")
          .attr("x", xScale(option.strike))
          .attr("y", isPuts ? 0 : 0) // strike label all in line
          .attr("text-anchor", "middle")
          .style("font-size", "10px")
          .style("fill", "#333")
          .style("font-weight", "500")
          .text(option.strike);
        });
      }
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
                
                if (d.type === 'up_arrow') {
                    // Triangle pointing up (in SVG coordinates, this means negative Y offset)
                    return `M ${x},${y - 8} L ${x - 6},${y + 4} L ${x + 6},${y + 4} Z`;
                } else if (d.type === 'down_arrow') {
                    // Triangle pointing down (in SVG coordinates, this means positive Y offset)
                    return `M ${x},${y + 8} L ${x - 6},${y - 4} L ${x + 6},${y - 4} Z`;
                } else if (d.type === 'zero_crossing') {
                    // Gray circle
                    return `M ${x + 6},${y} A 6,6 0 0,0 ${x - 6},${y} A 6,6 0 0,0 ${x + 6},${y} Z`;
                } else if (d.type === 'curve_endpoint') {
                    // Orange square for curve endpoints
                    return `M ${x - 6},${y - 6} L ${x + 6},${y - 6} L ${x + 6},${y + 6} L ${x - 6},${y + 6} Z`;
                }
                return '';
            })
            .attr("fill", d => {
                if (d.type === 'up_arrow') return '#4CAF50';   // green ▲ (local bottom)
                if (d.type === 'down_arrow') return '#F44336';  // red ▼ (local top)
                if (d.type === 'zero_crossing') return '#808080';
                if (d.type === 'curve_endpoint') return '#FF9800'; // Orange
                return '#666';
            })
            .attr("stroke", "white")
            .attr("stroke-width", 1);

        // Add labels for key points
        keyPointMarkers.append("text")
            .attr("x", d => xScale(d.closingPrice))
            .attr("y", d => {
                const y = yScale(d.totalIntrinsicValue);
                if (d.type === 'up_arrow') return y + 14;
                if (d.type === 'down_arrow') return y - 7;
                if (d.type === 'zero_crossing') return y - 7;
                if (d.type === 'curve_endpoint') return y - 7;
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
                
                if (d.type === 'up_arrow') {
                    // Triangle pointing up (in SVG coordinates, this means negative Y offset)
                    return `M ${x},${y - 8} L ${x - 6},${y + 4} L ${x + 6},${y + 4} Z`;
                } else if (d.type === 'down_arrow') {
                    // Triangle pointing down (in SVG coordinates, this means positive Y offset)
                    return `M ${x},${y + 8} L ${x - 6},${y - 4} L ${x + 6},${y - 4} Z`;
                } else if (d.type === 'zero_crossing') {
                    // Light gray circle
                    return `M ${x + 6},${y} A 6,6 0 0,0 ${x - 6},${y} A 6,6 0 0,0 ${x + 6},${y} Z`;
                } else if (d.type === 'curve_endpoint') {
                    // Light orange square for curve endpoints
                    return `M ${x - 6},${y - 6} L ${x + 6},${y - 6} L ${x + 6},${y + 6} L ${x - 6},${y + 6} Z`;
                }
                return '';
            })
            .attr("fill", d => {
                if (d.type === 'up_arrow') return '#81C784';   // light green ▲
                if (d.type === 'down_arrow') return '#EF9A9A';  // light red ▼
                if (d.type === 'zero_crossing') return '#A0A0A0';
                if (d.type === 'curve_endpoint') return '#FFCC80'; // Light orange
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
                if (d.type === 'up_arrow') return y + 14;
                if (d.type === 'down_arrow') return y - 7;
                if (d.type === 'zero_crossing') return y - 7;
                if (d.type === 'curve_endpoint') return y - 7;
                return y;
            })
            .attr("text-anchor", "middle")
            .attr("font-size", "11px")
            .attr("font-weight", "bold")
            .attr("fill", "#333")
            .text(d => `$${d.closingPrice.toFixed(0)}`);
    }

    // Vertical dotted line for the current underlying price. Always drawn whenever
    // we have a real price; if the price sits beyond the x-axis range it's clamped
    // to the nearest edge (with an arrow on the label) rather than hidden.
    if (Number.isFinite(underlyingPrice) && underlyingPrice > 0) {
        const minPrice = d3.min(data, d => d.closingPrice);
        const maxPrice = d3.max(data, d => d.closingPrice);
        const clampedPrice = Math.max(minPrice, Math.min(maxPrice, underlyingPrice));
        const xPos = xScale(clampedPrice);
        const offLow = underlyingPrice < minPrice;
        const offHigh = underlyingPrice > maxPrice;

        svg.append("line")
            .attr("x1", xPos)
            .attr("y1", yScale(d3.min(data, d => d.totalIntrinsicValue)))
            .attr("x2", xPos)
            .attr("y2", yScale(d3.max(data, d => d.totalIntrinsicValue)))
            .attr("stroke", "gray")
            .attr("stroke-width", 1)
            .attr("stroke-dasharray", "8, 4")
            .style("opacity", 0.7);

        // Label box below the x-axis; add ←/→ when the price is off the visible range.
        const labelGroup = svg.append("g")
            .attr("transform", `translate(${xPos}, ${height - 5})`);
        const labelText = `${offLow ? '← ' : ''}$${underlyingPrice.toFixed(2)}${offHigh ? ' →' : ''}`;
        const textWidth = labelText.length * 7;
        const textHeight = 16;

        labelGroup.append("rect")
            .attr("x", -textWidth/2 - 4)
            .attr("y", -textHeight - 2)
            .attr("width", textWidth + 8)
            .attr("height", textHeight + 4)
            .attr("fill", "white")
            .attr("stroke", "lightgray")
            .attr("stroke-width", 1)
            .attr("rx", 3)
            .style("opacity", 0.9);

        labelGroup.append("text")
            .attr("text-anchor", "middle")
            .attr("dy", -5)
            .style("font-size", "11px")
            .style("fill", "gray")
            .style("font-weight", "bold")
            .text(labelText);
    }

    // Add a group for the interactive elements (drawn last to appear on top)
    const interactionGroup = svg.append("g");

    // Draws the click info box(es) at underlying price x0. Split out from the
    // pointer handler so a redraw (e.g. a live price update) can re-apply the last
    // click instead of losing it.
    function renderClickInfo(x0) {
        // Remove any existing vertical line and label
        interactionGroup.selectAll(".vertical-line, .chart-label, .chart-label-bg").remove();

        // Find the closest data point to x0 (guarding the ends of the range)
        const bisectDate = d3.bisector(d => d.closingPrice).left;
        const i = bisectDate(data, x0, 1);
        const d0 = data[i - 1];
        const d1 = data[i];
        const d = !d1 ? d0 : !d0 ? d1 : (x0 - d0.closingPrice > d1.closingPrice - x0 ? d1 : d0);
        if (!d) return;
        
        // Add vertical line
        interactionGroup.append("line")
            .attr("class", "vertical-line")
            .attr("x1", xScale(d.closingPrice))
            .attr("y1", yScale.range()[0])
            .attr("x2", xScale(d.closingPrice))
            .attr("y2", yScale.range()[1])
            .attr("stroke", "#87CEEB")
            .attr("stroke-width", 1)
            .attr("stroke-dasharray", "3,3");
        
        // Calculate profit/loss
        const profitLoss = d.totalIntrinsicValue - cost;
        const profitLossText = profitLoss >= 0 ? `+$${profitLoss.toFixed(2)}` : `-$${Math.abs(profitLoss).toFixed(2)}`;
        const profitLossColor = profitLoss >= 0 ? '#4CAF50' : '#F44336';
        
        // Top line is the underlying price (the x-axis value) this info reflects,
        // then the position value and profit/loss at that price.
        const labelText = `@ $${d.closingPrice.toFixed(2)}\n$${d.totalIntrinsicValue.toFixed(2)}\n${profitLossText}`;
        const labelX = xScale(d.closingPrice);
        //const labelY = yScale(d.totalIntrinsicValue) - 10;
        // Nudged up so the taller 3-line box (price/value/P&L) doesn't clip below
        // the bottom of the drawing canvas.
        const labelY = 337;
        
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

          if (index === 0) {
            // Underlying price line — muted so the value/P&L stay the focus.
            tspan.attr("fill", "#666").attr("font-size", "11px");
          } else if (index === 2) {
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

        // If a temp position exists, add a second box showing the value / P&L of
        // the "with temp added" scenario at the same price, up near its own
        // (green dotted) combined-cost line.
        if (tempData && tempData.length > 0 && combinedCost !== null && combinedCost !== undefined) {
            const tIdx = bisectDate(tempData, x0, 1);
            const t0 = tempData[tIdx - 1];
            const t1 = tempData[tIdx];
            const tempD = (t0 && t1) ? (x0 - t0.closingPrice > t1.closingPrice - x0 ? t1 : t0) : (t1 || t0);
            if (tempD) {
                const tempPl = tempD.totalIntrinsicValue - combinedCost;
                const tempPlText = tempPl >= 0 ? `+$${tempPl.toFixed(2)}` : `-$${Math.abs(tempPl).toFixed(2)}`;
                const tempPlColor = tempPl >= 0 ? '#4CAF50' : '#F44336';
                // Same 3-line format as the main box: underlying price / value / P&L.
                const tempLabelText = `@ $${tempD.closingPrice.toFixed(2)}\n$${tempD.totalIntrinsicValue.toFixed(2)}\n${tempPlText}`;
                const tempLabelY = yScale(combinedCost) - 30; // just above the green line

                const tempTextEl = interactionGroup.append("text")
                    .attr("class", "chart-label")
                    .attr("x", labelX)
                    .attr("y", tempLabelY)
                    .attr("text-anchor", "middle")
                    .attr("alignment-baseline", "middle");

                tempLabelText.split('\n').forEach((line, index) => {
                    const tspan = tempTextEl.append("tspan")
                        .attr("x", labelX)
                        .attr("dy", index === 0 ? "0" : "1.2em")
                        .text(line);
                    if (index === 0) {
                        tspan.attr("fill", "#666").attr("font-size", "11px");
                    } else if (index === 2) {
                        tspan.attr("fill", tempPlColor).attr("font-size", "12px");
                    }
                });

                const tempBbox = tempTextEl.node().getBBox();
                interactionGroup.insert("rect", "text")
                    .attr("class", "chart-label-bg")
                    .attr("x", tempBbox.x - 2)
                    .attr("y", tempBbox.y - 2)
                    .attr("width", tempBbox.width + 4)
                    .attr("height", tempBbox.height + 4);
            }
        }
    }

    function handlePointerEvent(event) {
        event.preventDefault(); // Prevent default touch behavior
        const touch = event.type.includes('touch') ? event.changedTouches[0] : event;
        const [xCoord] = d3.pointer(touch, this);
        lastClickedPrice = xScale.invert(xCoord);
        renderClickInfo(lastClickedPrice);
    }

    // Add event listeners for both mouse and touch events
    svg.on("click", handlePointerEvent)
       .on("touchstart", handlePointerEvent);

    // Re-apply the last click so a redraw (e.g. a live price update) preserves the
    // info box the user opened rather than clearing it.
    if (lastClickedPrice !== null) renderClickInfo(lastClickedPrice);
}

// Re-render the chart with only the underlying price changed (keeps the payoff
// curve, options, and any open click info box). Used to keep the current-price
// line in sync as live data ticks, without the caller recomputing the curve.
function redrawChartWithPrice(price) {
    if (!lastChartArgs) return;
    const a = lastChartArgs;
    drawChart(a.data, a.cost, a.optionArray, a.tempData, price, a.combinedCost);
}

// Export chart functions for use in other modules
window.ChartModule = {
    calculatePortfolioValueAtExpiration,
    findKeyPointsOnCurve,
    drawChart,
    redrawChartWithPrice
};

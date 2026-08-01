// Chart Module - Contains all charting functionality

// calculatePortfolioValueAtExpiration now lives in shared/portfolio-risk.js so
// server-side code can reuse the identical math for aggregate risk analysis —
// see PortfolioRisk.analyzePortfolioRisk / findPortfolioHedgeCandidates.
const calculatePortfolioValueAtExpiration = PortfolioRisk.calculatePortfolioValueAtExpiration;

/**
 * Find key points on the value curve: local lows, highs, and break-even points.
 * @param {Array<object>} valueCurve - Array of objects with closingPrice and totalIntrinsicValue
 * @param {number} cost - The total cost of the position
 * @returns {Array<object>} Array of key points with type and value information
 */
function findKeyPointsOnCurve(valueCurve, cost) {
    if (!Array.isArray(valueCurve) || valueCurve.length < 3) {
        return [];
    }

    const keyPoints = [];
    let trend = null; // 'up', 'down', or 'flat'
    let lastNonFlatPoint = null;
    let flatStartIndex = null;

    // Check the first point - if it's different from the second point, mark it
    if (valueCurve.length >= 2) {
        const first = valueCurve[0];
        const second = valueCurve[1];
        const firstValue = first.totalIntrinsicValue - cost;
        const secondValue = second.totalIntrinsicValue - cost;
        
        if (firstValue !== secondValue) {
            keyPoints.push({
                type: 'curve_endpoint',
                closingPrice: first.closingPrice,
                totalIntrinsicValue: first.totalIntrinsicValue,
                description: 'Curve Start'
            });
        }
    }

    for (let i = 1; i < valueCurve.length - 1; i++) {
        const prev = valueCurve[i - 1];
        const current = valueCurve[i];
        const next = valueCurve[i + 1];

        const prevValue = prev.totalIntrinsicValue - cost;
        const currentValue = current.totalIntrinsicValue - cost;
        const nextValue = next.totalIntrinsicValue - cost;

        // Determine current trend
        let currentTrend;
        if (currentValue > prevValue) {
            currentTrend = 'up';
        } else if (currentValue < prevValue) {
            currentTrend = 'down';
        } else {
            currentTrend = 'flat';
        }

        // Handle trend changes
        if (trend !== currentTrend) {
            if (trend !== 'up' && currentTrend === 'up') {
                // Low point (trend changes from down to up)
                keyPoints.push({
                    type: 'low_point',
                    closingPrice: prev.closingPrice,
                    totalIntrinsicValue: prev.totalIntrinsicValue,
                    description: 'Low point'
                });
            } else if (trend !== 'down' && currentTrend === 'down') {
                // High point (trend changes from up to down)
                keyPoints.push({
                    type: 'high_point',
                    closingPrice: prev.closingPrice,
                    totalIntrinsicValue: prev.totalIntrinsicValue,
                    description: 'High point'
                });
            } else if (trend === 'flat' && currentTrend !== 'flat') {
                // Transition from flat to trend - use the last non-flat point as the turning point
                if (lastNonFlatPoint) {
                    const pointType = currentTrend === 'up' ? 'low_point' : 'high_point';
                    const description = currentTrend === 'up' ? 'Low point (after flat)' : 'High point (after flat)';
                    
                    keyPoints.push({
                        type: pointType,
                        closingPrice: lastNonFlatPoint.closingPrice,
                        totalIntrinsicValue: lastNonFlatPoint.totalIntrinsicValue,
                        description: description
                    });
                }
            }

            trend = currentTrend;
        }

         // Check for zero crossing (profit/loss crosses zero)
        if ((prevValue < 0 && currentValue >= 0) || (prevValue > 0 && currentValue <= 0)) {
            keyPoints.push({
                type: 'zero_crossing',
                closingPrice: current.closingPrice,
                totalIntrinsicValue: current.totalIntrinsicValue,
                description: 'Break-even'
            });
        }

        // Track the last non-flat point
        if (currentTrend !== 'flat') {
            lastNonFlatPoint = current;
        }
    }

    // Check the last point - if it's different from the second-to-last point, mark it
    if (valueCurve.length >= 2) {
        const last = valueCurve[valueCurve.length - 1];
        const secondLast = valueCurve[valueCurve.length - 2];
        const lastValue = last.totalIntrinsicValue - cost;
        const secondLastValue = secondLast.totalIntrinsicValue - cost;
        
        if (lastValue !== secondLastValue) {
            keyPoints.push({
                type: 'curve_endpoint',
                closingPrice: last.closingPrice,
                totalIntrinsicValue: last.totalIntrinsicValue,
                description: 'Curve End'
            });
        }
    }

    return keyPoints;
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

    // Calculate the min and max of totalIntrinsicValue from data
    const minIntrinsicValue = d3.min(data, d => d.totalIntrinsicValue);
    const maxIntrinsicValue = d3.max(data, d => d.totalIntrinsicValue);

    // Determine the overall min and max for the Y-axis domain, including the cost
    const overallMinY = Math.min(minIntrinsicValue, cost);
    const overallMaxY = Math.max(maxIntrinsicValue, cost);
    
    // Calculate 10% of the range for padding
    const yRange = overallMaxY - overallMinY;
    const yPadding = yRange * 0.1;

    // Create scales
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d.closingPrice))
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
                
                if (d.type === 'low_point') {
                    // Green triangle pointing up (in SVG coordinates, this means negative Y offset)
                    return `M ${x},${y - 8} L ${x - 6},${y + 4} L ${x + 6},${y + 4} Z`;
                } else if (d.type === 'high_point') {
                    // Red triangle pointing down (in SVG coordinates, this means positive Y offset)
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
                if (d.type === 'low_point') return '#4CAF50';
                if (d.type === 'high_point') return '#F44336';
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
                if (d.type === 'low_point') return y + 14;
                if (d.type === 'high_point') return y - 7;
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
                
                if (d.type === 'low_point') {
                    // Light green triangle pointing up (in SVG coordinates, this means negative Y offset)
                    return `M ${x},${y - 8} L ${x - 6},${y + 4} L ${x + 6},${y + 4} Z`;
                } else if (d.type === 'high_point') {
                    // Light red triangle pointing down (in SVG coordinates, this means positive Y offset)
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
                if (d.type === 'low_point') return '#81C784';
                if (d.type === 'high_point') return '#EF9A9A';
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
                if (d.type === 'low_point') return y + 14;
                if (d.type === 'high_point') return y - 7;
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

        // Add vertical line for current underlying price if provided
    if (underlyingPrice !== null && underlyingPrice !== undefined) {
        // Check if underlying price is within the chart range
        const minPrice = d3.min(data, d => d.closingPrice);
        const maxPrice = d3.max(data, d => d.closingPrice);
        
        if (underlyingPrice >= minPrice && underlyingPrice <= maxPrice) {
            svg.append("line")
                .attr("x1", xScale(underlyingPrice))
                .attr("y1", yScale(d3.min(data, d => d.totalIntrinsicValue)))
                .attr("x2", xScale(underlyingPrice))
                .attr("y2", yScale(d3.max(data, d => d.totalIntrinsicValue)))
                .attr("stroke", "gray")
                .attr("stroke-width", 1)  // Thinner line (was 2)
                .attr("stroke-dasharray", "8, 4")
                .style("opacity", 0.7);
            
            // Add label box below x-axis
            const labelGroup = svg.append("g")
                .attr("transform", `translate(${xScale(underlyingPrice)}, ${height - 5})`);
            
            // Add background rectangle for label
            const labelText = `$${underlyingPrice.toFixed(2)}`;
            const textWidth = labelText.length * 7; // Approximate text width
            const textHeight = 16;
            
            labelGroup.append("rect")
                .attr("x", -textWidth/2 - 4)
                .attr("y", -textHeight - 2)
                .attr("width", textWidth + 8)
                .attr("height", textHeight + 4)
                .attr("fill", "white")
                .attr("stroke", "lightgray")
                .attr("stroke-width", 1)
                .attr("rx", 3)  // Rounded corners
                .style("opacity", 0.9);
            
            // Add text label
            labelGroup.append("text")
                .attr("text-anchor", "middle")
                .attr("dy", -5)  // Center vertically in the box
                .style("font-size", "11px")
                .style("fill", "gray")
                .style("font-weight", "bold")
                .text(labelText);
            
            console.log(`📍 Added underlying price line at $${underlyingPrice.toFixed(2)} with label box`);
        } else {
            console.log(`⚠️ Underlying price $${underlyingPrice.toFixed(2)} is outside chart range ($${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)})`);
        }
    }

    // Add a group for the interactive elements (drawn last to appear on top)
    const interactionGroup = svg.append("g");

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

    // Add event listeners for both mouse and touch events
    svg.on("click", handlePointerEvent)
       .on("touchstart", handlePointerEvent);
}

// Export chart functions for use in other modules
window.ChartModule = {
    calculatePortfolioValueAtExpiration,
    findKeyPointsOnCurve,
    drawChart
};

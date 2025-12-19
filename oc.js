


/* input sample json
{
  "cost": 2000,
  "minStrike": 22700,
  "maxStrike": 22950,
  "strikeIncrement": 10,
  "optionArray": [
    {"strike":22720, "type":"c", "qty":1 },
    {"strike":22740, "type":"c", "qty":1 },
    {"strike":22860, "type":"p", "qty":1 },
    {"strike":22820, "type":"p", "qty":1 }
      ]
}
*/



   // Initialize input from local storage on page load
    document.addEventListener('DOMContentLoaded', (event) => {
      const savedInput = localStorage.getItem('savedOptionInput');
      if (savedInput) {
        document.getElementById('textInput').value = savedInput;
      }
    });




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
        
        // Convert the option string to array of option objects if it's a string
        let optionArray;
        if (typeof processedJSON.optionArray === 'string') {
          optionArray = processedJSON.optionArray
            .split(',')
            .map(optionStr => optionStr.trim())
            .filter(optionStr => optionStr)  // Remove any empty strings
            .map(optionStr => {
              const match = optionStr.match(/^([+-]?\d+)([cp])(\d+)$/i);
            if (!match) {
              throw new Error(`Invalid option format: ${optionStr}. Expected format like 1c100 or -1p110`);
            }
            return {
              qty: parseInt(match[1], 10),
              type: match[2].toLowerCase(),
              strike: parseFloat(match[3])
            };
          });
        } else if (Array.isArray(processedJSON.optionArray)) {
          // Process array format, ensuring string values are trimmed
          optionArray = processedJSON.optionArray.map(option => {
            if (typeof option === 'string') {
              option = option.trim();
              const match = option.match(/^([+-]?\d+)([cp])(\d+)$/i);
              if (!match) {
                throw new Error(`Invalid option format: ${option}. Expected format like 1c100 or -1p110`);
              }
              return {
                qty: parseInt(match[1], 10),
                type: match[2].toLowerCase(),
                strike: parseFloat(match[3])
              };
            }
            // If it's already an object, ensure type is lowercase and trim any string values
            if (typeof option === 'object' && option !== null) {
              return {
                ...option,
                type: option.type?.toString()?.toLowerCase()?.trim(),
                strike: typeof option.strike === 'string' ? parseFloat(option.strike.trim()) : option.strike,
                qty: typeof option.qty === 'string' ? parseInt(option.qty.trim(), 10) : (option.qty || 1)
              };
            }
            return option;
          });
        } else {
          throw new Error('optionArray must be either a string or an array');
        }
        
        const optionArrayLength = optionArray.length;
        
        if (optionArrayLength === 0) {
          throw new Error('No options provided in optionArray');
        }
  
        const optionSetConfig = calculatePortfolioValueAtExpiration(
          optionArray,
          processedJSON.minStrike,
          processedJSON.maxStrike,
          processedJSON.strikeIncrement || 1,
          processedJSON.contractMultiplier || 100
        );
  
        let outputStr = `
          <strong>Processed Output:</strong><br>
          <strong>Position Count:</strong> ${optionArrayLength}<br><br>
        `;
  
        console.log("Processing complete");
  
        optionSetConfig.forEach(point => {
          console.log(`  Closing: $${point.closingPrice.toFixed(2)} -- Value: $${point.totalIntrinsicValue.toFixed(2)}`);
          outputStr += `  Closing: $${point.closingPrice.toFixed(2)} -- Value: $${point.totalIntrinsicValue.toFixed(2)}<br>`;
        });
  
          outputDiv.innerHTML = outputStr;
        
        // Draw the chart if the function exists
        if (typeof drawChart === 'function') {
          drawChart(optionSetConfig, processedJSON.cost || 0, optionArray);
        }
      } catch (error) {
        console.error('Error:', error);
        outputDiv.innerHTML = `<span style="color: red">Error: ${error.message}</span>`;
      }  



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








function drawChart(data, cost, optionArray = []) {
    const margin = { top: 30, right: 30, bottom: 60, left: 60 };
    const width = document.getElementById('chart').offsetWidth - margin.left - margin.right;
    const height = document.getElementById('chart').offsetHeight - margin.top - margin.bottom;

    // Clear any existing SVG
    d3.select("#chart-container").select("svg").remove();

    const svg = d3.select("#chart-container")
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

    // Set up scales
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d.closingPrice))
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain([overallMinY, overallMaxY])
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

    // Add the line for option values
    const line = d3.line()
        .x(d => xScale(d.closingPrice))
        .y(d => yScale(d.totalIntrinsicValue));

    svg.append("path")
        .datum(data)
        .attr("fill", "none")
        .attr("stroke", "steelblue")
        .attr("stroke-width", 1.5)
        .attr("d", line);

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
      const optionCircles = svg.append("g")
          .selectAll(".option-circle")
          .data(optionArray)
          .enter()
          .append("g")
          .attr("class", "option-circle")
          .attr("transform", d => `translate(${xScale(d.strike)}, 20)`); // Position at top with 20px margin

      // Add the circle
      optionCircles.append("circle")
          .attr("r", 10) // Slightly larger to fit quantity
          .attr("fill", d => d.type === 'c' ? '#4CAF50' : '#F44336') // Green for calls, red for puts
          .attr("stroke", "white")
          .attr("stroke-width", 1.5);

      // Add the text (qty + type, e.g. "2C")
      optionCircles.append("text")
          .attr("text-anchor", "middle")
          .attr("dy", ".35em")
          .attr("fill", "white")
          .style("font-weight", "bold")
          .style("font-size", "10px")
          .text(d => `${Math.abs(d.qty)}${d.type.toUpperCase()}`);

      // Add strike price below the circle
      optionCircles.append("text")
          .attr("y", 20) // Position below the circle
          .attr("text-anchor", "middle")
          .style("font-size", "10px")
          .style("fill", "#333")
          .style("font-weight", "500")
          .text(d => d.strike);
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
        const labelText = `$${d.totalIntrinsicValue.toFixed(2)}`;
        const labelX = xScale(d.closingPrice);
        const labelY = yScale(d.totalIntrinsicValue) - 10;
        
        // Add background rectangle first
        const textElement = interactionGroup.append("text")
            .attr("class", "chart-label")
            .attr("x", labelX)
            .attr("y", labelY)
            .text(labelText);
        
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

    // Add event listeners for both mouse and touch events
    svg.on("click", handlePointerEvent)
       .on("touchstart", handlePointerEvent)
       .on("touchmove", handlePointerEvent);
}


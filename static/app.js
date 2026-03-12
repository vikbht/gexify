document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('ticker-form');
    const tickerInput = document.getElementById('ticker-input');
    const analyzeBtn = document.getElementById('analyze-btn');
    const spinner = document.getElementById('loading-spinner');
    const btnText = analyzeBtn.querySelector('span');
    const resultsPanel = document.getElementById('results-panel');
    const errorBanner = document.getElementById('error-message');

    // UI Elements for Data
    const displayTicker = document.getElementById('display-ticker');
    const spotPriceDisplay = document.getElementById('spot-price-display');
    const expirationDisplay = document.getElementById('expiration-display');
    const expirationSelect = document.getElementById('expiration-select');
    const supportLevel = document.getElementById('support-level');
    const resistanceLevel = document.getElementById('resistance-level');
    const flipLevel = document.getElementById('flip-level');
    const netDex = document.getElementById('net-dex');
    const dexToggleBtn = document.getElementById('dex-toggle');

    let gexChart = null;       // Chart.js instance for GEX bar chart
    let sparklineChart = null; // Chart.js instance for intraday price sparkline
    let dexVisible = true;     // Whether the DEX overlay is currently shown

    // DEX toggle button — show/hide the third dataset (index 2)
    dexToggleBtn.addEventListener('click', () => {
        if (!gexChart) return;
        dexVisible = !dexVisible;
        gexChart.data.datasets[2].hidden = !dexVisible;
        gexChart.update();
        dexToggleBtn.classList.toggle('active', dexVisible);
    });

    // Fetch expirations when user types a ticker
    tickerInput.addEventListener('blur', async () => {
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!ticker || ticker.length < 1) return;

        try {
            const response = await fetch(`/api/gex/${ticker}/expirations`);
            const data = await response.json();

            if (response.ok && data.expirations.length > 0) {
                // Populate Dropdown
                expirationSelect.innerHTML = ''; // Removed 'Auto-select Nearest'
                data.expirations.forEach(exp => {
                    const option = document.createElement('option');
                    option.value = exp;
                    option.textContent = exp;
                    expirationSelect.appendChild(option);
                });
                expirationSelect.disabled = false;
            } else {
                expirationSelect.innerHTML = '<option value="" disabled selected>No Dates Found</option>';
                expirationSelect.disabled = true;
            }
        } catch (err) {
            console.error("Failed to fetch expirations");
        }
    });

    // Auto-update charts when expiration is changed
    expirationSelect.addEventListener('change', () => {
        if (tickerInput.value.trim() !== '') {
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const ticker = tickerInput.value.trim().toUpperCase();
        if (!ticker) return;

        // UI Reset & Loading State
        setLoading(true);
        errorBanner.classList.add('hidden');
        resultsPanel.classList.remove('visible');
        resultsPanel.classList.add('hidden');

        try {
            const selectedExp = expirationSelect.value;
            const queryParams = selectedExp && !expirationSelect.disabled ? `?expiration=${selectedExp}` : '';
            const response = await fetch(`/api/gex/${ticker}${queryParams}`);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.detail || data.message || 'Failed to fetch GEX data');
            }

            renderResults(data);

        } catch (error) {
            console.error("Error fetching GEX:", error);
            showError(error.message);
        } finally {
            setLoading(false);
        }
    });

    function setLoading(isLoading) {
        if (isLoading) {
            spinner.classList.remove('hidden');
            btnText.style.opacity = '0.7';
            analyzeBtn.disabled = true;
        } else {
            spinner.classList.add('hidden');
            btnText.style.opacity = '1';
            analyzeBtn.disabled = false;
        }
    }

    function showError(message) {
        // Populate the detail paragraph with the actual API error message
        document.getElementById('error-detail').textContent = message || 'An unexpected error occurred.';
        errorBanner.classList.remove('hidden');
    }

    // Retry button re-submits the form
    document.getElementById('retry-btn').addEventListener('click', () => {
        errorBanner.classList.add('hidden');
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    function renderResults(data) {
        // Update Badges
        displayTicker.textContent = data.ticker;
        spotPriceDisplay.textContent = `$${data.spot_price.toFixed(2)}`;
        expirationDisplay.textContent = data.expiration_date;

        // Update GEX Flip badge (orange) — null if no zero-crossing found in filtered window
        flipLevel.textContent = data.gex_flip_strike ? `$${data.gex_flip_strike.toFixed(2)}` : 'N/A';

        // Update Net DEX badge (purple)
        // Sum all total_dex values and express in billions for readability
        const billionScale = 1_000_000_000;
        if (data.dex_data && data.dex_data.length > 0) {
            const totalDex = data.dex_data.reduce((sum, d) => sum + d.total_dex, 0);
            const sign = totalDex >= 0 ? '+' : '';
            netDex.textContent = `${sign}${(totalDex / billionScale).toFixed(2)}B`;
        } else {
            netDex.textContent = 'N/A';
        }

        // Render GEX chart immediately; defer sparkline one frame so the
        // results panel is fully visible and the canvas has real pixel dimensions.
        renderChart(data);
        // Reveal panel with fade-in: remove hidden first (sets display), then
        // add .visible one frame later so the CSS transition has something to animate from.
        resultsPanel.classList.remove('hidden');
        requestAnimationFrame(() => {
            resultsPanel.classList.add('visible');
            renderSparkline(data);
        });
    }

    function renderChart(data) {
        const ctx = document.getElementById('gexChart').getContext('2d');

        // Destroy existing chart if it exists
        if (gexChart) {
            gexChart.destroy();
        }

        const spotPrice = data.spot_price;
        const gexData = data.gex_data;

        // Optimization: Filter data to +/- 15% of spot price
        const lowerBound = spotPrice * 0.85;
        const upperBound = spotPrice * 1.15;

        const filteredData = gexData.filter(d => d.strike >= lowerBound && d.strike <= upperBound);

        const labels = filteredData.map(d => d.strike);

        // Convert to Billions for readability
        const billionScale = 1_000_000_000;
        const callGexData = filteredData.map(d => d.call_gex / billionScale);
        const putGexData = filteredData.map(d => d.put_gex / billionScale);

        // Styling Variables
        const gridColor = 'rgba(255, 255, 255, 0.05)';
        const textColor = '#94a3b8';

        // 1. Calculate major Support and Resistance levels
        let maxCallGex = 0;
        let resistanceStrike = null;
        let maxPutGex = 0; // absolute value
        let supportStrike = null;

        filteredData.forEach(d => {
            if (d.call_gex > maxCallGex) {
                maxCallGex = d.call_gex;
                resistanceStrike = d.strike;
            }
            if (Math.abs(d.put_gex) > maxPutGex) {
                maxPutGex = Math.abs(d.put_gex);
                supportStrike = d.strike;
            }
        });

        // Update UI Badges
        supportLevel.textContent = supportStrike ? `$${supportStrike.toFixed(2)}` : 'N/A';
        resistanceLevel.textContent = resistanceStrike ? `$${resistanceStrike.toFixed(2)}` : 'N/A';

        // 2. Build DEX line data aligned to the same filtered strike window
        // DEX is in raw dollars — scale to billions on a separate axis
        const dexByStrike = {};
        if (data.dex_data) {
            data.dex_data.forEach(d => { dexByStrike[d.strike] = d.total_dex; });
        }
        const dexLineData = labels.map(strike => (dexByStrike[strike] ?? 0) / billionScale);

        // 3. Render GEX Chart — pass flipStrike and dexLineData
        const flipStrike = data.gex_flip_strike;
        renderGexChart(ctx, labels, callGexData, putGexData, dexLineData, spotPrice, flipStrike, gridColor, textColor);

        // 4. Update Insights Banner
        const localGex = filteredData.reduce((acc, d) => acc + d.total_gex, 0) / billionScale;

        const insightBanner = document.getElementById('insight-banner');
        const insightTitle = document.getElementById('insight-title');
        const insightText = document.getElementById('insight-text');
        const insightIcon = document.getElementById('insight-icon');

        insightBanner.className = 'insight-banner'; // reset classes
        if (localGex >= 0) {
            insightBanner.classList.add('positive');
            insightIcon.textContent = '🛡️';
            insightTitle.textContent = `Market Regime: Positive GEX (+${localGex.toFixed(2)}B)`;
            insightText.innerHTML = "<strong>Market Makers suppressing volatility.</strong><br/>Expect choppy action. <span style='color: #4ade80;'>Buy Calls at Support</span>. <span style='color: #f87171;'>Buy Puts at Resistance</span>.";
        } else {
            insightBanner.classList.add('negative');
            insightIcon.textContent = '🚀';
            insightTitle.textContent = `Market Regime: Negative GEX (${localGex.toFixed(2)}B)`;
            insightText.innerHTML = "<strong>Market Makers amplifying volatility.</strong><br/>Expect large directional moves. <span style='color: #4ade80;'>Buy Calls on breakout</span>. <span style='color: #f87171;'>Buy Puts on breakdown</span>.";
        }
    }

    function renderGexChart(ctx, labels, callGexData, putGexData, dexLineData, spotPrice, flipStrike, gridColor, textColor) {
        gexChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        // Dataset 0: Call GEX (green bars, positive side)
                        label: 'Call GEX (Positive)',
                        data: callGexData,
                        backgroundColor: 'rgba(34, 197, 94, 0.7)',
                        borderColor: '#22c55e',
                        borderWidth: 1,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(34, 197, 94, 1)',
                        yAxisID: 'y',
                        order: 2
                    },
                    {
                        // Dataset 1: Put GEX (red bars, negative side)
                        label: 'Put GEX (Negative)',
                        data: putGexData,
                        backgroundColor: 'rgba(239, 68, 68, 0.7)',
                        borderColor: '#ef4444',
                        borderWidth: 1,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(239, 68, 68, 1)',
                        yAxisID: 'y',
                        order: 2
                    },
                    {
                        // Dataset 2: Net DEX line (purple) on secondary right Y-axis
                        // Renders on top of bars (order: 1) so it stays readable at all times
                        label: 'Net DEX',
                        data: dexLineData,
                        type: 'line',
                        borderColor: '#a78bfa',
                        borderWidth: 2.5,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        pointHoverBackgroundColor: '#a78bfa',
                        tension: 0.4,
                        fill: false,
                        yAxisID: 'y1',  // right-side secondary axis
                        order: 1,
                        hidden: !dexVisible  // respects toggle state
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: false // We built our own custom legend in HTML
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        titleColor: '#f8fafc',
                        bodyColor: '#e2e8f0',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 12,
                        callbacks: {
                            title: function (context) {
                                return `Strike: $${context[0].label}`;
                            },
                            label: function (context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    // DEX line (dataset index 2) — show with 'B' suffix
                                    // GEX bars (dataset indices 0 & 1) — same format
                                    const val = context.parsed.y;
                                    const sign = val > 0 ? '+' : '';
                                    if (context.datasetIndex === 2) {
                                        label += `${sign}${val.toFixed(2)}B`;
                                    } else {
                                        label += `${val.toFixed(2)}B`;
                                    }
                                }
                                return label;
                            }
                        }
                    },
                    annotation: {
                        // Chart.js annotation plugin isn't loaded by default, 
                        // so we simulate the "spot line" by hacking the layout or using a custom plugin.
                        // For simplicity in Vanilla ChartJS without the annotation plugin, 
                        // we'll leave it as a mental note or you can add chartjs-plugin-annotation.
                    }
                },
                scales: {
                    x: {
                        stacked: true,
                        grid: {
                            color: gridColor,
                            drawBorder: false
                        },
                        ticks: {
                            color: textColor,
                            maxRotation: 45,
                            minRotation: 45,
                            callback: function (value, index, values) {
                                // Add $ prefix to x-axis
                                return '$' + this.getLabelForValue(value);
                            }
                        },
                        title: {
                            display: true,
                            text: 'Strike Price',
                            color: textColor,
                            font: {
                                size: 14,
                                weight: '500'
                            }
                        }
                    },
                    y: {
                        stacked: false, // We want them overlapping/side-by-side or stacked on zero line
                        grid: {
                            color: (context) => {
                                // Highlight the zero line
                                if (context.tick.value === 0) {
                                    return 'rgba(255, 255, 255, 0.2)';
                                }
                                return gridColor;
                            },
                            lineWidth: (context) => context.tick.value === 0 ? 2 : 1,
                            drawBorder: false
                        },
                        ticks: {
                            color: textColor,
                            callback: function (value, index, values) {
                                // Convert 0 to integer to avoid 0.00B, leave others as fixed 2 decimals
                                return value === 0 ? '0B' : value.toFixed(2) + 'B';
                            }
                        },
                        title: {
                            display: true,
                            text: 'Gamma Exposure ($ Billions)',
                            color: textColor,
                            font: {
                                size: 14,
                                weight: '500'
                            }
                        }
                    },
                    // Secondary right-side axis for DEX line
                    // No grid lines (would duplicate left GEX grid) — only ticks
                    y1: {
                        position: 'right',
                        display: dexVisible, // hide axis when DEX overlay is toggled off
                        grid: { drawOnChartArea: false },
                        ticks: {
                            color: '#a78bfa',   // purple to match the DEX line
                            callback: value => value === 0 ? '0B' : value.toFixed(2) + 'B'
                        },
                        title: {
                            display: true,
                            text: 'Delta Exposure ($ Billions)',
                            color: '#a78bfa',
                            font: { size: 13, weight: '500' }
                        }
                    }
                }
            },
            plugins: [{
                // Custom plugin: draws the Spot Price line AND the GEX Flip line as vertical dashed overlays
                id: 'spotPriceLine',
                afterDraw: (chart) => {
                    const ctx = chart.ctx;
                    const xAxis = chart.scales.x;
                    const yAxis = chart.scales.y;

                    // Helper: resolve pixel X for an arbitrary price value using label interpolation
                    function getPricePixel(price) {
                        let px = xAxis.getPixelForValue(price);
                        if (isNaN(px) || px === undefined) {
                            for (let i = 0; i < labels.length - 1; i++) {
                                if (price >= labels[i] && price <= labels[i + 1]) {
                                    const ratio = (price - labels[i]) / (labels[i + 1] - labels[i]);
                                    const p1 = xAxis.getPixelForTick(i);
                                    const p2 = xAxis.getPixelForTick(i + 1);
                                    px = p1 + (p2 - p1) * ratio;
                                    break;
                                }
                            }
                        }
                        return px;
                    }

                    // Helper: draw a vertical dashed line with a floating label above it
                    function drawPriceLine(px, lineColor, labelText) {
                        if (!px || isNaN(px)) return;
                        ctx.save();
                        ctx.beginPath();
                        ctx.moveTo(px, yAxis.top);
                        ctx.lineTo(px, yAxis.bottom);
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = lineColor;
                        ctx.setLineDash([5, 5]);
                        ctx.stroke();

                        // Floating label background pill
                        ctx.font = '11px Inter, sans-serif';
                        const textWidth = ctx.measureText(labelText).width;
                        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
                        ctx.fillRect(px - textWidth / 2 - 6, yAxis.top - 20, textWidth + 12, 20);

                        // Label text
                        ctx.fillStyle = lineColor;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(labelText, px, yAxis.top - 10);
                        ctx.restore();
                    }

                    // 1. White dashed line — current spot price
                    drawPriceLine(
                        getPricePixel(spotPrice),
                        'rgba(255, 255, 255, 0.85)',
                        `Spot: $${spotPrice.toFixed(2)}`
                    );

                    // 2. Orange dashed line — GEX flip level (if it exists within our ±15% window)
                    if (flipStrike) {
                        drawPriceLine(
                            getPricePixel(flipStrike),
                            '#fb923c',
                            `GEX Flip: $${flipStrike.toFixed(2)}`
                        );
                    }
                }
            }]
        });
    }

    // --- Intraday Price Sparkline ---
    function renderSparkline(data) {
        const sparkCtx = document.getElementById('sparklineChart').getContext('2d');
        const marketClosedMsg = document.getElementById('market-closed-msg');
        const sparkCanvas = document.getElementById('sparklineChart');

        // Destroy previous instance to avoid memory leaks on repeated analyses
        if (sparklineChart) {
            sparklineChart.destroy();
        }

        const prices = data.historical_prices;

        // Market-closed / no-data detection:
        // Empty array  → no bars at all (market closed, holiday, or pre-market call)
        // All identical prices → yfinance returned a flat/stale series (also closed)
        const isMarketClosed = !prices || prices.length === 0 ||
            prices.every(p => p.price === prices[0].price);

        if (isMarketClosed) {
            // Hide canvas, show friendly message overlay
            sparkCanvas.style.display = 'none';
            marketClosedMsg.classList.remove('hidden');
            return;
        }

        // Market is open / data available — hide overlay, restore canvas
        sparkCanvas.style.display = 'block';
        marketClosedMsg.classList.add('hidden');

        const labels = prices.map(p => p.date);
        const values = prices.map(p => p.price);


        // Build a gradient fill beneath the line
        const gradient = sparkCtx.createLinearGradient(0, 0, 0, 130);
        gradient.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
        gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

        // Calculate min/max with a small padding for a tight Y-axis
        const minPrice = Math.min(...values);
        const maxPrice = Math.max(...values);
        const padding = (maxPrice - minPrice) * 0.15 || 1;

        sparklineChart = new Chart(sparkCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Price',
                    data: values,
                    borderColor: '#38bdf8',
                    borderWidth: 2,
                    pointRadius: 0,          // no dots — clean sparkline look
                    pointHoverRadius: 4,
                    tension: 0.4,            // smooth bezier curve
                    fill: true,
                    backgroundColor: gradient
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        titleColor: '#94a3b8',
                        bodyColor: '#f8fafc',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 10,
                        callbacks: {
                            label: ctx => `$${ctx.parsed.y.toFixed(2)}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: '#94a3b8',
                            maxTicksLimit: 8,   // only show ~8 time labels to avoid clutter
                            maxRotation: 0
                        }
                    },
                    y: {
                        min: minPrice - padding,
                        max: maxPrice + padding,
                        grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
                        ticks: {
                            color: '#94a3b8',
                            callback: v => `$${v.toFixed(0)}`
                        }
                    }
                }
            }
        });
    }
});

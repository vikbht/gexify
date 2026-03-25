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
    const viewModeRadios = document.getElementsByName('view_mode');
    const supportLevel = document.getElementById('support-level');
    const resistanceLevel = document.getElementById('resistance-level');
    const flipLevel = document.getElementById('flip-level');

    // Auto-Refresh Elements
    const autoRefreshToggle = document.getElementById('auto-refresh-toggle');
    const refreshGroup = document.querySelector('.auto-refresh-group');
    const lastRefreshedSpan = document.getElementById('last-refreshed');
    
    let gexChart = null;       // Chart.js instance for main GEX profile
    let autoRefreshInterval = null; // Keeps track of the setInterval ID

    // Fetch expirations when user types a ticker
    tickerInput.addEventListener('blur', async () => {
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!ticker || ticker.length < 1) return;

        // Check if Total Market mode is active. If so, don't re-enable the dropdown.
        const isTotalMarket = Array.from(viewModeRadios).find(r => r.checked)?.value === 'total';
        
        try {
            const response = await fetch(`/api/gex/${ticker}/expirations`);
            const data = await response.json();

            if (response.ok && data.expirations.length > 0) {
                // Populate Dropdown
                expirationSelect.innerHTML = '';
                data.expirations.forEach(expObj => {
                    const option = document.createElement('option');
                    
                    // The value submitted to the API remains just the raw date string
                    option.value = expObj.date;
                    
                    // Format the Net GEX value for display (in Billions)
                    const gexBillion = expObj.net_gex / 1_000_000_000;
                    const sign = gexBillion > 0 ? '+' : '';
                    const formattedGex = `${sign}${(gexBillion).toFixed(2)}B`;
                    
                    // Determine Emoji Heatmap coloring based on +/- $100M threshold
                    let emoji = '⚪'; // Neutral
                    if (expObj.net_gex < -100_000_000) emoji = '🔴'; // Negative GEX regime
                    if (expObj.net_gex > 100_000_000) emoji = '🟢';  // Positive GEX regime
                    
                    option.textContent = `${emoji} ${expObj.date} (${formattedGex})`;
                    expirationSelect.appendChild(option);
                });
                if (!isTotalMarket) {
                    expirationSelect.disabled = false;
                }
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

    // --- Auto-Refresh Logic ---
    
    // Hide toggle initially until a successful search happens
    refreshGroup.style.display = 'none';

    autoRefreshToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            // Start polling every 60 seconds (60000 ms)
            autoRefreshInterval = setInterval(() => {
                if (tickerInput.value.trim() !== '') {
                    // Trigger a background submit (we'll skip the heavy loading spinner to keep UX smooth)
                    fetchGexData(true);
                }
            }, 60000);
        } else {
            // Stop polling
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }
    });

    // Cleanup interval if user manually types a new ticker
    tickerInput.addEventListener('input', () => {
        autoRefreshToggle.checked = false;
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        refreshGroup.style.display = 'none';
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await fetchGexData(false);
    });
    
    // View Mode Toggle Logic
    viewModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const multiDateModes = ['total', 'term_structure'];
            if (multiDateModes.includes(e.target.value)) {
                expirationSelect.disabled = true;
            } else {
                // Only enable if there are options and a ticker is entered
                if (expirationSelect.options.length > 0 && expirationSelect.options[0].value !== "") {
                    expirationSelect.disabled = false;
                }
            }
            
            // Auto-trigger analyze if a ticker is already entered and valid
            if (tickerInput.value.trim().length > 0) {
                fetchGexData(false);
            }
        });
    });

    async function fetchGexData(isAutoRefresh) {
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!ticker) return;

        // Only show the full screen blocking spinner if this is a manual, non-cached search
        if (!isAutoRefresh) {
            setLoading(true);
            errorBanner.classList.add('hidden');
            resultsPanel.classList.remove('visible');
            resultsPanel.classList.add('hidden');
        }

        try {
            const viewMode = Array.from(viewModeRadios).find(r => r.checked)?.value || 'single';
            const selectedExp = expirationSelect.value;
            
            let queryParams = `?view_mode=${viewMode}`;
            if (viewMode === 'single' && selectedExp && !expirationSelect.disabled) {
                queryParams += `&expiration=${selectedExp}`;
            }

            const response = await fetch(`/api/gex/${ticker}${queryParams}`);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.detail || data.message || 'Failed to fetch GEX data');
            }

            // Show the auto-refresh toggle now that we have valid data
            refreshGroup.style.display = 'flex';
            
            renderResults(data);

        } catch (error) {
            console.error("Error fetching GEX:", error);
            // If auto-refresh fails, notify user and turn it off
            if (isAutoRefresh) {
                autoRefreshToggle.checked = false;
                clearInterval(autoRefreshInterval);
                autoRefreshInterval = null;
            }
            showError(error.message);
        } finally {
            if (!isAutoRefresh) {
                setLoading(false);
            }
        }
    }

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

        // Render Chart
        const viewMode = Array.from(viewModeRadios).find(r => r.checked)?.value || 'single';
        const chartjsContainer = document.getElementById('chartjs-container');
        
        if (viewMode === 'term_structure') {
            chartjsContainer.classList.remove('hidden');
            renderTermStructureChart(data);
        } else {
            chartjsContainer.classList.remove('hidden');
            renderChart(data);
        }
        // Reveal panel with fade-in: remove hidden first (sets display), then
        // add .visible one frame later so the CSS transition has something to animate from.
        resultsPanel.classList.remove('hidden');
        requestAnimationFrame(() => {
            resultsPanel.classList.add('visible');
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

        // Calculate major Support and Resistance levels
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
        document.getElementById('badge-support').style.display = '';
        document.getElementById('badge-resistance').style.display = '';
        document.getElementById('badge-flip').style.display = '';
        supportLevel.textContent = supportStrike ? `$${supportStrike.toFixed(2)}` : 'N/A';
        resistanceLevel.textContent = resistanceStrike ? `$${resistanceStrike.toFixed(2)}` : 'N/A';

        const flipStrike = data.gex_flip_strike;
        renderGexChart(ctx, labels, callGexData, putGexData, spotPrice, flipStrike, gridColor, textColor);

        // Update Insights Banner
        const localGex = filteredData.reduce((acc, d) => acc + d.total_gex, 0) / billionScale;

        const insightBanner = document.getElementById('insight-banner');
        const insightTitle = document.getElementById('insight-title');
        const insightText = document.getElementById('insight-text');
        const insightIcon = document.getElementById('insight-icon');
        const lastRefreshedSpan = document.getElementById('last-refreshed');

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

        // --- Last Refreshed Timestamp ---
        const now = new Date();
        const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        lastRefreshedSpan.textContent = `Last Refreshed: ${timeString}`;
        lastRefreshedSpan.classList.remove('hidden');
    }



    function renderTermStructureChart(data) {
        const ctx = document.getElementById('gexChart').getContext('2d');
        if (gexChart) gexChart.destroy();
        
        const billionScale = 1_000_000_000;
        const labels = data.gex_data.map(d => d.date);
        const callGexData = data.gex_data.map(d => d.call_gex / billionScale);
        const putGexData = data.gex_data.map(d => d.put_gex / billionScale);
        
        gexChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Call GEX', data: callGexData, backgroundColor: 'rgba(34, 197, 94, 0.7)', borderColor: '#22c55e', borderWidth: 1, yAxisID: 'y' },
                    { label: 'Put GEX', data: putGexData, backgroundColor: 'rgba(239, 68, 68, 0.7)', borderColor: '#ef4444', borderWidth: 1, yAxisID: 'y' }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, grid: { color: 'rgba(255, 255, 255, 0.05)', drawBorder: false }, ticks: { color: '#94a3b8', maxRotation: 45, minRotation: 45 } },
                    y: { stacked: false, grid: { color: (c) => c.tick.value === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)', lineWidth: (c) => c.tick.value === 0 ? 2 : 1 }, ticks: { color: '#94a3b8', callback: (v) => v === 0 ? '0B' : v.toFixed(2) + 'B' } }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { 
                        backgroundColor: 'rgba(15, 23, 42, 0.9)', 
                        titleColor: '#f8fafc', 
                        bodyColor: '#e2e8f0', 
                        callbacks: { 
                            label: function(c) { return `${c.dataset.label}: ${c.parsed.y.toFixed(2)}B`; },
                            afterLabel: function(c) {
                                const dp = data.gex_data[c.dataIndex];
                                if (c.datasetIndex === 0 && dp.dom_call_strike) {
                                    return `Top Strike: $${dp.dom_call_strike.toFixed(2)}`;
                                } else if (c.datasetIndex === 1 && dp.dom_put_strike) {
                                    return `Top Strike: $${dp.dom_put_strike.toFixed(2)}`;
                                }
                                return '';
                            }
                        } 
                    }
                }
            }
        });
        document.getElementById('badge-support').style.display = 'none';
        document.getElementById('badge-resistance').style.display = 'none';
        document.getElementById('badge-flip').style.display = 'none';
        document.getElementById('insight-banner').className = 'insight-banner hidden';
    }

    function renderGexChart(ctx, labels, callGexData, putGexData, spotPrice, flipStrike, gridColor, textColor) {
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
                                if (label) label += ': ';
                                if (context.parsed.y !== null) {
                                    label += `${context.parsed.y.toFixed(2)}B`;
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
});

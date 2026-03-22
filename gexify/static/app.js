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

    let gexChart = null; // Chart.js instance for GEX

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
        errorBanner.textContent = message;
        errorBanner.classList.remove('hidden');
    }

    function renderResults(data) {
        // Update Badges
        displayTicker.textContent = data.ticker;
        spotPriceDisplay.textContent = `$${data.spot_price.toFixed(2)}`;
        expirationDisplay.textContent = data.expiration_date;

        // Render Chart
        renderChart(data);

        // Show Panel
        resultsPanel.classList.remove('hidden');
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

        // 2. Render GEX Chart
        renderGexChart(ctx, labels, callGexData, putGexData, spotPrice, gridColor, textColor);

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

    function renderGexChart(ctx, labels, callGexData, putGexData, spotPrice, gridColor, textColor) {
        gexChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Call GEX (Positive)',
                        data: callGexData,
                        backgroundColor: 'rgba(34, 197, 94, 0.7)', // vivid green
                        borderColor: '#22c55e',
                        borderWidth: 1,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(34, 197, 94, 1)'
                    },
                    {
                        label: 'Put GEX (Negative)',
                        data: putGexData,
                        backgroundColor: 'rgba(239, 68, 68, 0.7)', // vivid red
                        borderColor: '#ef4444',
                        borderWidth: 1,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(239, 68, 68, 1)'
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
                    }
                }
            },
            plugins: [{
                // Custom plugin to draw the Spot Price vertical line
                id: 'spotPriceLine',
                afterDraw: (chart) => {
                    const ctx = chart.ctx;
                    const xAxis = chart.scales.x;
                    const yAxis = chart.scales.y;

                    // Find the pixel position for the spot price
                    // We need to interpolate between labels if the exact spot isn't a strike
                    let pixelX = xAxis.getPixelForValue(spotPrice);

                    // Fallback interpolation if Chart.js exact value matching fails
                    if (isNaN(pixelX) || pixelX === undefined) {
                        // rough estimation
                        for (let i = 0; i < labels.length - 1; i++) {
                            if (spotPrice >= labels[i] && spotPrice <= labels[i + 1]) {
                                const ratio = (spotPrice - labels[i]) / (labels[i + 1] - labels[i]);
                                const p1 = xAxis.getPixelForTick(i);
                                const p2 = xAxis.getPixelForTick(i + 1);
                                pixelX = p1 + (p2 - p1) * ratio;
                                break;
                            }
                        }
                    }

                    if (pixelX && !isNaN(pixelX)) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.moveTo(pixelX, yAxis.top);
                        ctx.lineTo(pixelX, yAxis.bottom);
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
                        ctx.setLineDash([5, 5]);
                        ctx.stroke();

                        // Add label background
                        ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
                        const text = `Spot: $${spotPrice.toFixed(2)}`;
                        const textWidth = ctx.measureText(text).width;
                        ctx.fillRect(pixelX - textWidth / 2 - 6, yAxis.top - 20, textWidth + 12, 20);

                        // Add label text
                        ctx.fillStyle = '#fff';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.font = '12px Inter, sans-serif';
                        ctx.fillText(text, pixelX, yAxis.top - 10);

                        ctx.restore();
                    }
                }
            }]
        });
    }
});

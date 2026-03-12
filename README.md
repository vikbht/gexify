# Gexify 📊

**Real-time Options Gamma Exposure (GEX) Profiler**

Gexify is a web tool for options traders that fetches live options chain data, calculates Gamma Exposure (GEX) per strike price using the Black-Scholes model, and visualizes it as an interactive chart — helping you identify key support, resistance, and market volatility regimes.

---

## ✨ Features

- **Live GEX Chart** — Bar chart of Call GEX (positive) vs Put GEX (negative) per strike, filtered to ±15% of the current spot price
- **Spot Price Line** — Dashed vertical line showing the current price on the chart
- **Support & Resistance Detection** — Automatically identifies the strike with the highest put GEX (support) and call GEX (resistance)
- **Market Regime Insight** — Tells you whether the market is in a Positive GEX (low vol/choppy) or Negative GEX (high vol/trending) regime
- **Expiration Picker** — Dynamically loads available options expiration dates for any ticker
- **Dark Glassmorphism UI** — Clean, modern dark-mode interface built with vanilla JS + CSS

---

## 🎬 Demo

> **Live analysis of SPY** — Spot: $676.33 | Expiry: 2026-03-12 | Regime: 🚀 Negative GEX (-0.04B)

![Gexify Demo Screenshot](docs/demo_screenshot.png)

*The chart shows Call GEX (green bars) vs Put GEX (red bars) per strike price. The dashed white vertical line marks the current spot price. Support ($675) and Resistance ($680) are auto-detected from peak GEX concentrations.*

📹 [Watch the full interactive demo recording](docs/demo.webp)

---

## 🧮 How GEX is Calculated

Gamma Exposure is computed using the **Black-Scholes gamma formula**:

```
Γ = N'(d1) / (S × σ × √T)

where:
  d1 = [ln(S/K) + (r + 0.5σ²)T] / (σ√T)
  S  = Spot Price
  K  = Strike Price
  T  = Time to expiration (years)
  r  = Risk-free rate (4%)
  σ  = Implied Volatility
```

Then GEX per strike is:
- **Calls:** `GEX = Γ × Open Interest × 100 × Spot`
- **Puts:** `GEX = Γ × Open Interest × 100 × Spot × (−1)`

---

## 🗂️ Project Structure

```
gexify/
├── app/
│   ├── main.py                    # FastAPI app setup, CORS, static mount
│   ├── api/
│   │   └── endpoints.py           # API routes
│   ├── models/
│   │   └── gex.py                 # Pydantic response models
│   └── services/
│       └── gex_calculator.py      # Black-Scholes gamma + yfinance data fetching
├── static/
│   ├── index.html                 # Single-page frontend
│   ├── app.js                     # Chart rendering + API calls (Chart.js)
│   └── styles.css                 # Dark glassmorphism theme
├── pyproject.toml                 # Python dependencies (uv)
└── main.py                        # Root entry point
```

---

## 🚀 Getting Started

### Prerequisites

- Python 3.13+
- [`uv`](https://docs.astral.sh/uv/) package manager

### Installation & Run

```bash
# Clone the repo
git clone <repo-url>
cd gexify

# Install dependencies
uv sync

# Start the server
uv run uvicorn app.main:app --reload
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/gex/{ticker}/expirations` | List available options expiration dates |
| `GET` | `/api/gex/{ticker}?expiration=YYYY-MM-DD` | Fetch full GEX profile for a ticker |

### Example

```bash
# Get expirations for SPY
curl http://localhost:8000/api/gex/SPY/expirations

# Get GEX for SPY on a specific expiry
curl "http://localhost:8000/api/gex/SPY?expiration=2025-04-17"
```

---

## 📦 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI, Uvicorn |
| Data | yfinance, pandas, numpy, scipy |
| Models | Pydantic v2 |
| Frontend | Vanilla JS, Chart.js |
| Styling | Vanilla CSS (Glassmorphism) |
| Package Mgmt | `uv` |

---

## 📖 Reading the Chart

| Signal | Meaning |
|--------|---------|
| 🟢 **Positive GEX (green bars)** | Call gamma — market makers hedge by selling into rallies (suppresses upside) |
| 🔴 **Negative GEX (red bars)** | Put gamma — market makers hedge by buying dips (amplifies downside moves) |
| **Dashed white line** | Current spot price |
| **Support badge** | Strike with the largest put GEX concentration |
| **Resistance badge** | Strike with the largest call GEX concentration |
| 🛡️ **Positive GEX Regime** | Total GEX > 0 → market makers suppress vol → expect range-bound / choppy price action |
| 🚀 **Negative GEX Regime** | Total GEX < 0 → market makers amplify vol → expect large directional moves |

---

## ⚠️ Disclaimer

This tool is for **educational and informational purposes only**. It does not constitute financial advice. Always do your own research before making any trading decisions.

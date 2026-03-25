# Gexify Software Architecture

This document describes the high-level architecture of **Gexify**, an interactive dashboard for profiling Gamma Exposure (GEX) across equity and index option chains. It follows the [C4 Model](https://c4model.com/) approach for layered architectural representation.

---

## 1. System Context (Level 1)

The System Context diagram shows how Gexify fits into the broader ecosystem, identifying the users and external dependencies.

```mermaid
C4Context
    title System Context Diagram for Gexify

    Person(trader, "Options Trader", "A user analyzing options flow, market regimes, and dealer gamma positioning.")
    System(gexify, "Gexify Dashboard", "Allows traders to visualize real-time GEX across strikes and expirations.")
    
    System_Ext(yfinance, "Yahoo Finance / yfinance", "Provides live spot prices, historical intraday quotes, and massive option chains.")

    Rel(trader, gexify, "Views and interacts with dashboard", "Browser")
    Rel(gexify, yfinance, "Fetches market data", "HTTPS / API")
```

**Key Takeaways:**
* The system is fully self-contained on the user side.
* Gexify has no internal persistent database (e.g., PostgreSQL); it relies entirely on live external API fetching mapped into high-speed memory caches.

---

## 2. Container Diagram (Level 2)

The Container Diagram zooms into the `Gexify Dashboard` to show the high-level executable components.

```mermaid
C4Container
    title Container Diagram for Gexify

    Person(trader, "Options Trader", "A user analyzing options flow.")
    
    System_Boundary(c1, "Gexify System") {
        Container(spa, "Single-Page Application", "Vanilla JS, HTML/CSS, Chart.js", "Provides the responsive charting interface with Auto-Refresh and view toggles.")
        Container(api, "FastAPI Backend", "Python, FastAPI, Uvicorn", "Serves the API endpoints and orchestrates concurrent background tasks.")
        Container(engine, "Vectorized Math Engine", "Numpy, Pandas, SciPy", "Performs extremely fast Black-Scholes Greeks broadcasting calculations across arrays.")
        Container(cache, "In-Memory LRU Cache", "cachetools (TTLCache)", "Temporarily caches YF payloads (60-300s TTL) to prevent rate limits.")
    }
    
    System_Ext(yfinance, "Yahoo Finance", "Public Market Data")

    Rel(trader, spa, "Selects tickers and view modes", "HTTPS/WSS")
    Rel(spa, api, "Requests GEX payloads", "JSON/REST")
    Rel(api, engine, "Passes dataframes for profiling", "Method Call")
    Rel(api, cache, "Checks for recent payloads", "Memory")
    Rel(engine, yfinance, "Pulls Option Chains", "YFinance Python API")
```

**Key Architectural Decisions:**
* **Frontend**: Vanilla JS was chosen over React/Vue to eliminate build steps and reduce payload overhead. `Chart.js` is used for high-performance Canvas rendering of thousands of bars.
* **Backend**: `FastAPI` provides maximum async throughput.
* **Math Engine**: Because large ETFs like SPY have thousands of active contracts across 40+ expirations, `Numpy` vectorization is utilized to process Black-Scholes arrays on the CPU instantly, natively bypassing Python loops.

---

## 3. Component Diagram (Level 3 - Backend)

Zooming into the Python FastAPI container to see the structural breakdown of the business logic.

```mermaid
C4Component
    title Component Diagram for Gexify Backend
    
    Container_Boundary(api_boundary, "FastAPI Backend Application") {
        Component(routers, "API Endpoints (endpoints.py)", "FastAPI Routers", "Defines the /api/gex/{ticker} REST schema and view_mode routing logic.")
        Component(models, "Pydantic Models (gex.py)", "Pydantic", "Validates incoming params and formats the outgoing JSON responses for consistency.")
        Component(fetcher, "Data Fetchers", "yfinance, concurrent.futures", "Manages the multi-threaded I/O bounds. Executes parallel HTTP requests to YF.")
        Component(calculator, "Calculation Core", "calculate_gamma_vectorized", "Numpy-based subroutines for native CPU vector math.")
    }

    Rel(routers, models, "Uses for mapping")
    Rel(routers, fetcher, "Delegates data gathering to", "asyncio.run_in_executor")
    Rel(fetcher, calculator, "Injects raw arrays into")
```

---

## 4. Sequence & Data Flow Analysis

This section visualizes the synchronous flow of data during a complex multi-expiration calculation (e.g., *Term Structure* mode). Note how the architecture prevents blocking the main event-loop.

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant API (FastAPI)
    participant ThreadPool
    participant Yahoo Finance
    
    User->>Frontend: Enter "SPY", Select "Term"
    Frontend->>API: GET /api/gex/SPY?view_mode=term_structure
    
    API->>ThreadPool: Offload fetch_history_sync (I/O)
    ThreadPool->>Yahoo Finance: Fetch 1m spot prices & company info
    Yahoo Finance-->>ThreadPool: Return DataFrame

    API->>ThreadPool: Offload concurrent Option Chain fetches
    ThreadPool->>Yahoo Finance: Fetch all 40+ expiration dates concurrently
    Yahoo Finance-->>ThreadPool: Return massive Options DataFrames
    
    ThreadPool->>ThreadPool: Pass DataFrames to Numpy Vector Engine
    Note over ThreadPool: calculate_gamma_vectorized() broadcasts<br/>Black-Scholes array math in ~0.05 seconds.
    ThreadPool->>ThreadPool: Detect dominant strikes (numpy.argmax)
    
    ThreadPool-->>API: Return Pydantic Objects
    API-->>Frontend: JSON GexResponse
    
    Frontend->>Frontend: Bind JSON to Chart.js canvas
    Frontend-->>User: Visual Render Update
```

### Technical Highlights
1. **Thread Pool Offloading**: `yfinance` is completely synchronous and blocking. If triggered natively on the FastAPI async event loop, a single 3-second YF timeout would block all other users on the dashboard. Gexify uses `asyncio.get_running_loop().run_in_executor(None, ...)` to banish all YF and Pandas overhead to separate OS threads.
2. **TTLCaching**: Options are heavily cached via `cachetools`. Spot prices expire in 60s (for intraday liveliness) while full massive chain aggregations expire in 300s.
3. **Argmax Injection**: For the Term Structure UI, instead of sending the massive 3D surface back to the browser to compute the "top contributor" strikes, the Pandas thread calculates the `argmax` for Call/Put gamma clusters locally and injects it statically into the payload.

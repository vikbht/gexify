import yfinance as yf
import pandas as pd
import numpy as np
from scipy.stats import norm
import datetime
from app.models.gex import GexResponse, GexDataPoint, DexDataPoint, ExpirationResponse, HistoricalPriceItem

# --- Black-Scholes Gamma Calculation ---
def calculate_gamma(S, K, T, r, sigma):
    """
    Computes the Black-Scholes Gamma for a single option contract.

    Gamma measures the rate of change of delta with respect to the underlying
    price. Market makers who are long gamma (sold options to customers) must
    hedge dynamically — this hedging activity is what GEX captures.

    Args:
        S (float): Current spot price of the underlying
        K (float): Strike price of the option
        T (float): Time to expiration in years (e.g. 0.0274 for 10 days)
        r (float): Risk-free rate (annualized, e.g. 0.04 for 4%)
        sigma (float): Implied volatility (annualized, from the options chain)

    Returns:
        float: Gamma value (or 0.0 if inputs are degenerate)
    """
    # Guard against expired or zero-vol options which would cause division by zero
    if T <= 0 or sigma <= 0:
        return 0.0

    # d1 is the standardised log-moneyness adjusted for drift and vol
    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))

    # Gamma = N'(d1) / (S * sigma * sqrt(T))
    # N'(d1) is the standard normal PDF evaluated at d1
    gamma = norm.pdf(d1) / (S * sigma * np.sqrt(T))
    return gamma


# --- Black-Scholes Delta Calculation ---
def calculate_delta(S, K, T, r, sigma, option_type: str) -> float:
    """
    Computes the Black-Scholes Delta for a single option contract.

    Delta represents the rate of change of the option price with respect to
    the underlying spot price.  Dealers who sold options to customers must
    hold delta-equivalent shares in the underlying to stay hedged — the
    aggregate of this hedging activity is Delta Exposure (DEX).

    Call delta = N(d1)           ranges (0, 1)   → always positive
    Put  delta = N(d1) − 1       ranges (-1, 0)  → always negative

    Args:
        S (float): Current spot price
        K (float): Strike price
        T (float): Time to expiration in years
        r (float): Risk-free rate (annualized)
        sigma (float): Implied volatility (annualized)
        option_type (str): 'call' or 'put'

    Returns:
        float: Delta value (or 0.0 if inputs are degenerate)
    """
    if T <= 0 or sigma <= 0:
        return 0.0

    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))

    if option_type == 'call':
        return norm.cdf(d1)          # N(d1)
    else:
        return norm.cdf(d1) - 1.0    # N(d1) - 1  → negative for puts


def fetch_expirations(ticker_symbol: str) -> ExpirationResponse:
    ticker = yf.Ticker(ticker_symbol)
    try:
        expirations = ticker.options
        if not expirations:
            return ExpirationResponse(ticker=ticker_symbol, expirations=[], status="error", message="No options data found.")
        return ExpirationResponse(ticker=ticker_symbol, expirations=list(expirations))
    except Exception as e:
        return ExpirationResponse(ticker=ticker_symbol, expirations=[], status="error", message=str(e))

# --- Fetch Option Data & Calculate GEX ---
def fetch_and_calculate_gex(ticker_symbol: str, target_expiration: str = None) -> GexResponse:
    """
    Full pipeline: fetch intraday prices + options chain, compute GEX per strike.

    GEX (Gamma Exposure) in dollars is defined as:
      Call GEX = Gamma * Open_Interest * 100 * Spot
      Put  GEX = Gamma * Open_Interest * 100 * Spot * (-1)  [negative by convention]

    The sign convention reflects the net hedging pressure:
      - Positive GEX: market makers are long gamma → they sell rallies / buy dips → suppresses vol
      - Negative GEX: market makers are short gamma → they sell dips / buy rallies → amplifies vol

    Args:
        ticker_symbol (str): Stock/ETF ticker (e.g. "SPY", "AAPL")
        target_expiration (str, optional): Expiration date in "YYYY-MM-DD" format.
                                           Defaults to the nearest available expiry.

    Returns:
        GexResponse: Pydantic model with spot price, GEX profile, and intraday prices.
    """
    ticker = yf.Ticker(ticker_symbol)

    try:
        # --- Step 1: Fetch intraday spot price (1-day, 5-minute bars) ---
        history = ticker.history(period="1d", interval="5m")
        if history.empty:
            return GexResponse(ticker=ticker_symbol, spot_price=0.0, expiration_date="", gex_data=[], historical_prices=[], status="error", message="Failed to fetch spot price data.")

        # Use the most recent close as the live spot price
        spot_price = history['Close'].iloc[-1]

        # Build a list of (time, price) tuples for the intraday sparkline on the frontend
        historical_prices = []
        for dt_idx, row in history.iterrows():
            # Format as HH:MM string for the chart labels
            time_str = dt_idx.strftime("%H:%M")
            historical_prices.append(HistoricalPriceItem(
                date=time_str,
                price=row['Close']
            ))
        
        # --- Step 2: Resolve the target expiration date ---
        # yfinance returns expirations sorted ascending (nearest first)
        expirations = ticker.options
        if not expirations:
            return GexResponse(ticker=ticker_symbol, spot_price=spot_price, expiration_date="", gex_data=[], historical_prices=historical_prices, status="error", message="No options data found.")

        # Honor a user-selected date, otherwise fall back to the nearest expiry
        if target_expiration and target_expiration in expirations:
            target_exp = target_expiration
        else:
            target_exp = expirations[0]  # nearest expiration by default

        print(f"Processing {ticker_symbol} options for expiration: {target_exp} | Spot: ${spot_price:.2f}")

        # --- Step 3: Fetch the full options chain for the chosen expiry ---
        chain = ticker.option_chain(target_exp)
        calls = chain.calls  # DataFrame: strike, lastPrice, impliedVolatility, openInterest, ...
        puts = chain.puts

        # --- Step 4: Compute Time-to-Expiry (T) in fractional years ---
        exp_date = datetime.datetime.strptime(target_exp, "%Y-%m-%d")
        today = datetime.datetime.now()
        T = (exp_date - today).days / 365.25
        if T <= 0:
            T = 0.001  # treat same-day expiry as a near-zero but non-zero value

        r = 0.04  # risk-free rate proxy (approximate US 3-month T-bill rate)

        # --- Step 5: Calculate per-row Gamma AND Delta using Black-Scholes ---
        calls['Gamma'] = calls.apply(
            lambda row: calculate_gamma(spot_price, row['strike'], T, r, row['impliedVolatility']),
            axis=1
        )
        puts['Gamma'] = puts.apply(
            lambda row: calculate_gamma(spot_price, row['strike'], T, r, row['impliedVolatility']),
            axis=1
        )
        # Delta for calls: N(d1) ∈ (0, 1) — always positive
        calls['Delta'] = calls.apply(
            lambda row: calculate_delta(spot_price, row['strike'], T, r, row['impliedVolatility'], 'call'),
            axis=1
        )
        # Delta for puts: N(d1)−1 ∈ (−1, 0) — always negative
        puts['Delta'] = puts.apply(
            lambda row: calculate_delta(spot_price, row['strike'], T, r, row['impliedVolatility'], 'put'),
            axis=1
        )

        # --- Step 6: Convert Gamma → GEX and Delta → DEX (both dollar-denominated) ---
        # Multiplying by 100 accounts for standard US equity option contract size (100 shares)
        calls['GEX'] = calls['Gamma'] * calls['openInterest'] * 100 * spot_price
        puts['GEX'] = puts['Gamma'] * puts['openInterest'] * 100 * spot_price * (-1)  # puts are negative

        # DEX: Delta × OI × 100 × Spot  (inherits sign from delta — puts naturally negative)
        calls['DEX'] = calls['Delta'] * calls['openInterest'] * 100 * spot_price
        puts['DEX'] = puts['Delta'] * puts['openInterest'] * 100 * spot_price

        # --- Step 7: Merge calls and puts by strike price ---
        df_calls = calls[['strike', 'GEX', 'DEX']].rename(columns={'GEX': 'Call_GEX', 'DEX': 'Call_DEX'}).set_index('strike')
        df_puts = puts[['strike', 'GEX', 'DEX']].rename(columns={'GEX': 'Put_GEX', 'DEX': 'Put_DEX'}).set_index('strike')

        # Outer join on strike — fills missing strikes with 0
        combined = pd.concat([df_calls, df_puts], axis=1).fillna(0)
        combined['Total_GEX'] = combined['Call_GEX'] + combined['Put_GEX']
        combined['Total_DEX'] = combined['Call_DEX'] + combined['Put_DEX']

        # Keep reference to gex_profile variable for backward compat (same dataframe)
        gex_profile = combined

        # --- Step 8: Find the GEX Flip Level ---
        # Sort strikes ascending and compute a running cumulative sum of Total_GEX.
        # The "flip" is the first strike where the cumulative sum changes sign —
        # i.e. where dealer net gamma exposure transitions from positive to negative (or vice versa).
        sorted_profile = gex_profile.sort_index()

        def find_flip_strike(series):
            """Return the first strike where the cumulative sum of `series` crosses zero."""
            cumulative = series.cumsum()
            cum_values = cumulative.values
            cum_strikes = cumulative.index.values
            for i in range(len(cum_values) - 1):
                if cum_values[i] * cum_values[i + 1] < 0:  # opposite signs → zero crossing
                    return float(cum_strikes[i + 1])
            return None

        gex_flip_strike = find_flip_strike(sorted_profile['Total_GEX'])

        # --- Step 8b: Find the DEX Flip Level ---
        # Same logic applied to cumulative Total_DEX — the strike where dealer
        # net directional exposure changes sign (bullish ↔ bearish pivot).
        dex_flip_strike = find_flip_strike(sorted_profile['Total_DEX'])

        # --- Step 9: Serialize to Pydantic response models ---
        # Filter to ±15% of spot price — matches what the frontend chart displays.
        # Flip levels are calculated on the FULL dataset above for accuracy; we only
        # narrow the payload here to reduce wire size (~75% fewer data points).
        lower_bound = spot_price * 0.85
        upper_bound = spot_price * 1.15
        filtered_profile = gex_profile[
            (gex_profile.index >= lower_bound) & (gex_profile.index <= upper_bound)
        ]

        gex_data = []
        dex_data = []
        for strike, row in filtered_profile.iterrows():
            gex_data.append(GexDataPoint(
                strike=strike,
                call_gex=row['Call_GEX'],
                put_gex=row['Put_GEX'],
                total_gex=row['Total_GEX']
            ))
            dex_data.append(DexDataPoint(
                strike=strike,
                call_dex=row['Call_DEX'],
                put_dex=row['Put_DEX'],
                total_dex=row['Total_DEX']
            ))

        return GexResponse(
            ticker=ticker_symbol,
            spot_price=spot_price,
            expiration_date=target_exp,
            gex_data=gex_data,
            dex_data=dex_data,
            historical_prices=historical_prices,
            gex_flip_strike=gex_flip_strike,
            dex_flip_strike=dex_flip_strike
        )


    except Exception as e:
        # Return a structured error response so the frontend can display a message
        return GexResponse(ticker=ticker_symbol, spot_price=0.0, expiration_date="", gex_data=[], dex_data=[], historical_prices=[], status="error", message=str(e))


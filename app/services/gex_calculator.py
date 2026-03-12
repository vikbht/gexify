import yfinance as yf
import pandas as pd
import numpy as np
from scipy.stats import norm
import datetime
from app.models.gex import GexResponse, GexDataPoint, ExpirationResponse, HistoricalPriceItem

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

        # --- Step 5: Calculate per-row Gamma using Black-Scholes ---
        calls['Gamma'] = calls.apply(
            lambda row: calculate_gamma(spot_price, row['strike'], T, r, row['impliedVolatility']),
            axis=1
        )
        puts['Gamma'] = puts.apply(
            lambda row: calculate_gamma(spot_price, row['strike'], T, r, row['impliedVolatility']),
            axis=1
        )

        # --- Step 6: Convert Gamma → GEX (dollar-denominated) ---
        # Multiplying by 100 accounts for standard US equity option contract size (100 shares)
        calls['GEX'] = calls['Gamma'] * calls['openInterest'] * 100 * spot_price
        puts['GEX'] = puts['Gamma'] * puts['openInterest'] * 100 * spot_price * (-1)  # puts are negative

        # --- Step 7: Merge calls and puts by strike price ---
        df_calls = calls[['strike', 'GEX']].rename(columns={'GEX': 'Call_GEX'}).set_index('strike')
        df_puts = puts[['strike', 'GEX']].rename(columns={'GEX': 'Put_GEX'}).set_index('strike')

        # Outer join on strike — fills missing strikes with 0 GEX
        gex_profile = pd.concat([df_calls, df_puts], axis=1).fillna(0)
        gex_profile['Total_GEX'] = gex_profile['Call_GEX'] + gex_profile['Put_GEX']

        # --- Step 8: Find the GEX Flip Level ---
        # Sort strikes ascending and compute a running cumulative sum of Total_GEX.
        # The "flip" is the first strike where the cumulative sum changes sign —
        # i.e. where dealer net gamma exposure transitions from positive to negative (or vice versa).
        gex_flip_strike = None
        sorted_profile = gex_profile.sort_index()  # sort by strike ascending
        cumulative = sorted_profile['Total_GEX'].cumsum()
        # Walk through pairs of consecutive cumulative values to detect sign change
        cum_values = cumulative.values
        cum_strikes = cumulative.index.values
        for i in range(len(cum_values) - 1):
            if cum_values[i] * cum_values[i + 1] < 0:  # opposite signs → zero crossing
                gex_flip_strike = float(cum_strikes[i + 1])
                break

        # --- Step 9: Serialize to Pydantic response models ---
        gex_data = []
        for strike, row in gex_profile.iterrows():
            gex_data.append(GexDataPoint(
                strike=strike,
                call_gex=row['Call_GEX'],
                put_gex=row['Put_GEX'],
                total_gex=row['Total_GEX']
            ))

        return GexResponse(
            ticker=ticker_symbol,
            spot_price=spot_price,
            expiration_date=target_exp,
            gex_data=gex_data,
            historical_prices=historical_prices,
            gex_flip_strike=gex_flip_strike
        )

    except Exception as e:
        # Return a structured error response so the frontend can display a message
        return GexResponse(ticker=ticker_symbol, spot_price=0.0, expiration_date="", gex_data=[], historical_prices=[], status="error", message=str(e))

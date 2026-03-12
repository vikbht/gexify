import yfinance as yf
import pandas as pd
import numpy as np
from scipy.stats import norm
import datetime
from cachetools import cached, TTLCache
import concurrent.futures
from app.models.gex import GexResponse, GexDataPoint, ExpirationResponse, HistoricalPriceItem, ExpirationDetail

# --- Fast Vectorized Gamma Calculation ---
def calculate_gamma_vectorized(S, K, T, r, sigma):
    """Numpy vectorized computation for computing thousands of strikes instantly."""
    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    return norm.pdf(d1) / (S * sigma * np.sqrt(T))

# --- Standard Black-Scholes Gamma Calculation ---
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



@cached(cache=TTLCache(maxsize=100, ttl=300))
def fetch_term_structure(ticker_symbol: str) -> ExpirationResponse:
    """
    Fetches the total net GEX for every single available expiration date concurrently.
    This powers the 'Heatmap' feature in the frontend dropdown.
    """
    ticker = yf.Ticker(ticker_symbol)
    
    try:
        raw_expirations = getattr(ticker, 'options', [])
        if not raw_expirations:
            return ExpirationResponse(ticker=ticker_symbol, expirations=[])
            
        # Get spot price (we use the fast info or history to get a quick quote)
        spot_history = ticker.history(period="1d", interval="1m")
        if spot_history.empty:
            raise ValueError(f"No pricing data available for {ticker_symbol}.")
        spot_price = float(spot_history['Close'].iloc[-1])
        
        # We need a quick inner calculation for just one chain's total GEX
        def calc_chain_gex(exp_date):
            try:
                chain = ticker.option_chain(exp_date)
                calls, puts = chain.calls, chain.puts
                
                # Default risk-free rate 4%
                r = 0.04
                
                # Calculate time to expiration (T)
                expiration_dt = datetime.datetime.strptime(exp_date, "%Y-%m-%d")
                today = datetime.datetime.today()
                
                # 0DTE protection: if today IS expiration, use 0.001 year (a few hours)
                if expiration_dt.date() == today.date():
                    days_to_expiration = 0.5  # half a day
                else:
                    days_to_expiration = (expiration_dt - today).days

                # Time to expiration in fractional years
                T = max(days_to_expiration / 365.25, 0.001)
                
                total_gex = 0.0
                
                # Sum Call GEX
                if not calls.empty:
                    for _, row in calls.iterrows():
                        K = row['strike']
                        sigma = row['impliedVolatility']
                        oi = row['openInterest']
                        if pd.isna(oi) or oi == 0: continue
                        
                        gamma = calculate_gamma(spot_price, K, T, r, sigma)
                        call_gex = gamma * oi * 100 * spot_price
                        total_gex += call_gex
                
                # Sum Put GEX
                if not puts.empty:
                    for _, row in puts.iterrows():
                        K = row['strike']
                        sigma = row['impliedVolatility']
                        oi = row['openInterest']
                        if pd.isna(oi) or oi == 0: continue
                        
                        gamma = calculate_gamma(spot_price, K, T, r, sigma)
                        # Dealers sell puts -> short gamma. MMs who bought them are long gamma.
                        # Put GEX is negative impact.
                        put_gex = gamma * oi * 100 * spot_price * -1
                        total_gex += put_gex
                
                return ExpirationDetail(date=exp_date, net_gex=total_gex)
            except Exception as e:
                # If a single chain fails to load, just return 0 GEX so we don't break the whole list
                return ExpirationDetail(date=exp_date, net_gex=0.0)

        # Concurrently fetch all chains
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
            details = list(executor.map(calc_chain_gex, raw_expirations))

        # Filter out completely dead chains if necessary, or just return them all
        return ExpirationResponse(
            ticker=ticker_symbol,
            expirations=details
        )

    except Exception as e:
        return ExpirationResponse(
            ticker=ticker_symbol,
            expirations=[],
            status="error",
            message=f"Failed to fetch term structure: {str(e)}"
        )



@cached(cache=TTLCache(maxsize=100, ttl=300))
def fetch_expirations(ticker_symbol: str) -> ExpirationResponse:
    ticker = yf.Ticker(ticker_symbol)
    try:
        expirations = ticker.options
        if not expirations:
            return ExpirationResponse(ticker=ticker_symbol, expirations=[], status="error", message="No options data found.")
        return ExpirationResponse(ticker=ticker_symbol, expirations=list(expirations))
    except Exception as e:
        return ExpirationResponse(ticker=ticker_symbol, expirations=[], status="error", message=str(e))

# --- Cached Data Fetchers ---

@cached(cache=TTLCache(maxsize=100, ttl=60))
def fetch_history_sync(ticker_symbol: str):
    ticker = yf.Ticker(ticker_symbol)
    history = ticker.history(period="1d", interval="5m")
    if history.empty:
        raise ValueError("Failed to fetch spot price data. The market may be closed or the symbol is invalid.")
    
    spot_price = history['Close'].iloc[-1]
    historical_prices = []
    for dt_idx, row in history.iterrows():
        time_str = dt_idx.strftime("%H:%M")
        historical_prices.append(HistoricalPriceItem(
            date=time_str,
            price=row['Close']
        ))
    return spot_price, historical_prices

@cached(cache=TTLCache(maxsize=100, ttl=60))
def fetch_chain_sync(ticker_symbol: str, target_expiration: str = None):
    ticker = yf.Ticker(ticker_symbol)
    expirations = ticker.options
    if not expirations:
        raise ValueError("No options data found.")

    if target_expiration and target_expiration in expirations:
        target_exp = target_expiration
    else:
        target_exp = expirations[0]

    print(f"Fetching {ticker_symbol} options chain for expiration: {target_exp}")
    chain = ticker.option_chain(target_exp)
    return chain.calls, chain.puts, target_exp


# --- Total Market Calculation ---
def compute_total_market_gex(ticker_symbol: str, spot_price: float, historical_prices: list) -> GexResponse:
    """
    Computes aggregated GEX for ALL expirations simultaneously.
    Uses concurrent fetching and Numpy vectorized formulas for speed.
    """
    ticker = yf.Ticker(ticker_symbol)
    raw_expirations = getattr(ticker, 'options', [])
    if not raw_expirations:
        raise ValueError(f"No options data found for {ticker_symbol}")

    today = datetime.datetime.today().date()
    r = 0.04

    def process_chain(exp_date):
        try:
            chain = ticker.option_chain(exp_date)
            calls, puts = chain.calls, chain.puts
            
            expiration_dt = datetime.datetime.strptime(exp_date, "%Y-%m-%d").date()
            if expiration_dt == today:
                days_to_expiration = 0.5
            else:
                days_to_expiration = (expiration_dt - today).days

            T = max(days_to_expiration / 365.25, 0.001)
            
            # --- Vectorized Calls ---
            if not calls.empty:
                valid_calls = calls[calls['openInterest'] > 0].copy()
                if not valid_calls.empty:
                    K = valid_calls['strike'].values
                    sigma = valid_calls['impliedVolatility'].values
                    oi = valid_calls['openInterest'].values
                    
                    gamma = calculate_gamma_vectorized(spot_price, K, T, r, sigma)
                    valid_calls['call_gex'] = gamma * oi * 100 * spot_price
                else:
                    valid_calls['call_gex'] = 0.0
            else:
                calls['call_gex'] = 0.0
                valid_calls = calls

            # --- Vectorized Puts ---
            if not puts.empty:
                valid_puts = puts[puts['openInterest'] > 0].copy()
                if not valid_puts.empty:
                    K = valid_puts['strike'].values
                    sigma = valid_puts['impliedVolatility'].values
                    oi = valid_puts['openInterest'].values

                    gamma = calculate_gamma_vectorized(spot_price, K, T, r, sigma)
                    valid_puts['put_gex'] = gamma * oi * 100 * spot_price * -1
                else:
                    valid_puts['put_gex'] = 0.0
            else:
                puts['put_gex'] = 0.0
                valid_puts = puts

            dfs = []
            if not valid_calls.empty:
                dfs.append(valid_calls[['strike', 'call_gex']])
            if not valid_puts.empty:
                dfs.append(valid_puts[['strike', 'put_gex']])

            if not dfs: return pd.DataFrame(columns=['strike', 'call_gex', 'put_gex'])

            if len(dfs) == 2:
                res = pd.merge(dfs[0], dfs[1], on='strike', how='outer').fillna(0)
            else:
                res = dfs[0].copy()
                for col in ['call_gex', 'put_gex']:
                    if col not in res.columns: res[col] = 0.0

            return res
        except Exception as e:
            return pd.DataFrame(columns=['strike', 'call_gex', 'put_gex'])

    # Fetch and compute all chains concurrently
    with concurrent.futures.ThreadPoolExecutor(max_workers=30) as executor:
        results = list(executor.map(process_chain, raw_expirations))
        
    all_chains = [df for df in results if not df.empty]
    if not all_chains:
        raise ValueError("Could not aggregate total market data.")
        
    # Combine and sum by strike
    combined_df = pd.concat(all_chains, ignore_index=True)
    agg_df = combined_df.groupby('strike').sum().reset_index().sort_values('strike')
    
    # Calculate Totals
    agg_df['total_gex'] = agg_df['call_gex'] + agg_df['put_gex']

    # Format into Response Model
    gex_data = []
    cumulative_gex = 0.0
    gex_flip_strike = None

    for _, row in agg_df.iterrows():
        K = row['strike']

        gex_data.append(GexDataPoint(
            strike=K, call_gex=row['call_gex'], put_gex=row['put_gex'], total_gex=row['total_gex']
        ))

        if spot_price * 0.5 <= K <= spot_price * 1.5:
            prev_cum_gex = cumulative_gex
            cumulative_gex += row['total_gex']
            if prev_cum_gex < 0 and cumulative_gex >= 0 and gex_flip_strike is None:
                gex_flip_strike = K

    return GexResponse(
        ticker=ticker_symbol,
        spot_price=spot_price,
        expiration_date="Total Market (All Expirations)",
        gex_data=gex_data,
        historical_prices=historical_prices,
        gex_flip_strike=gex_flip_strike,
    )


# --- Pure Calculation Logic ---
def compute_gex_profile(ticker_symbol: str, spot_price: float, historical_prices: list, calls: pd.DataFrame, puts: pd.DataFrame, target_exp: str) -> GexResponse:
    """
    Computes the GEX profile purely from memory (no I/O operations).
    """
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
    try:
        # --- Compute Time-to-Expiry (T) in fractional years ---
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

        # Outer join on strike — fills missing strikes with 0
        combined = pd.concat([df_calls, df_puts], axis=1).fillna(0)
        combined['Total_GEX'] = combined['Call_GEX'] + combined['Put_GEX']

        gex_profile = combined

        # --- Step 8: Find the GEX Flip Level ---
        # Sort strikes ascending and compute a running cumulative sum of Total_GEX.
        # The "flip" is the first strike where the cumulative sum changes sign.
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

        # --- Step 9: Serialize to Pydantic response models ---
        # Filter to ±15% of spot price to reduce wire size.
        lower_bound = spot_price * 0.85
        upper_bound = spot_price * 1.15
        filtered_profile = gex_profile[
            (gex_profile.index >= lower_bound) & (gex_profile.index <= upper_bound)
        ]

        gex_data = [
            GexDataPoint(
                strike=strike,
                call_gex=row['Call_GEX'],
                put_gex=row['Put_GEX'],
                total_gex=row['Total_GEX']
            )
            for strike, row in filtered_profile.iterrows()
        ]

        return GexResponse(
            ticker=ticker_symbol,
            spot_price=spot_price,
            expiration_date=target_exp,
            gex_data=gex_data,
            historical_prices=historical_prices,
            gex_flip_strike=gex_flip_strike,
        )

    except Exception as e:
        # Return a structured error response so the frontend can display a message
        return GexResponse(ticker=ticker_symbol, spot_price=0.0, expiration_date="", gex_data=[], historical_prices=[], status="error", message=str(e))


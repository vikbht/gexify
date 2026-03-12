import asyncio
from fastapi import APIRouter, HTTPException, Path
from app.models.gex import GexResponse, ExpirationResponse
from app.services.gex_calculator import fetch_history_sync, fetch_chain_sync, compute_gex_profile, fetch_expirations
import logging

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/gex/{ticker}/expirations", response_model=ExpirationResponse)
async def get_expirations(ticker: str = Path(..., pattern="^[A-Za-z]{1,5}$", description="Stock ticker symbol")):
    """
    Return all available options expiration dates for a given ticker.

    The frontend calls this on ticker-input blur to pre-populate the
    expiration dropdown before the user hits 'Analyze GEX'.

    yfinance is a synchronous library — we offload it to a thread pool
    via run_in_executor so it never blocks the FastAPI event loop.
    """
    ticker = ticker.upper()  # normalise to uppercase (yfinance is case-sensitive)
    logger.info(f"Fetching expirations for {ticker}")

    loop = asyncio.get_running_loop()
    response = await loop.run_in_executor(None, fetch_expirations, ticker)

    if response.status == "error":
        raise HTTPException(status_code=400, detail=response.message)

    return response


@router.get("/gex/{ticker}", response_model=GexResponse)
async def get_gex(ticker: str = Path(..., pattern="^[A-Za-z]{1,5}$", description="Stock ticker symbol"), expiration: str = None):
    """
    Return the full Gamma Exposure (GEX) profile for a ticker.

    Triggers the complete Black-Scholes GEX pipeline:
      1. Fetch intraday spot price (yfinance, 5-min bars)
      2. Resolve the target expiration (user-selected or nearest)
      3. Fetch options chain  →  compute gamma  →  compute GEX per strike
      4. Detect GEX flip level (cumulative zero-crossing strike)

    yfinance is synchronous — we run it in a thread pool executor to
    keep the async event loop free for other incoming requests.

    Query params:
        expiration (str, optional): "YYYY-MM-DD" format.  Defaults to nearest expiry.
    """
    ticker = ticker.upper()  # normalise to uppercase
    logger.info(f"Fetching GEX for {ticker} (Exp: {expiration})")

    loop = asyncio.get_running_loop()
    
    try:
        # Run history and options fetch concurrently in the thread pool
        # This cuts the total yfinance network wait time almost in half
        history_task = loop.run_in_executor(None, fetch_history_sync, ticker)
        chain_task = loop.run_in_executor(None, fetch_chain_sync, ticker, expiration)
        
        # Wait for both I/O bounds to finish
        (spot_price, historical_prices), (calls, puts, target_exp) = await asyncio.gather(history_task, chain_task)
        
        # Pure computation is fast enough to run in the main thread (or pool)
        response = await loop.run_in_executor(
            None, 
            compute_gex_profile, 
            ticker, spot_price, historical_prices, calls, puts, target_exp
        )
        return response

    except Exception as e:
        logger.error(f"Error fetching GEX for {ticker}: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

import asyncio
from fastapi import APIRouter, HTTPException
from app.models.gex import GexResponse, ExpirationResponse
from app.services.gex_calculator import fetch_and_calculate_gex, fetch_expirations
import logging

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/gex/{ticker}/expirations", response_model=ExpirationResponse)
async def get_expirations(ticker: str):
    """
    Return all available options expiration dates for a given ticker.

    The frontend calls this on ticker-input blur to pre-populate the
    expiration dropdown before the user hits 'Analyze GEX'.

    yfinance is a synchronous library — we offload it to a thread pool
    via run_in_executor so it never blocks the FastAPI event loop.
    """
    ticker = ticker.upper()  # normalise to uppercase (yfinance is case-sensitive)
    logger.info(f"Fetching expirations for {ticker}")

    loop = asyncio.get_event_loop()
    response = await loop.run_in_executor(None, fetch_expirations, ticker)

    if response.status == "error":
        raise HTTPException(status_code=400, detail=response.message)

    return response


@router.get("/gex/{ticker}", response_model=GexResponse)
async def get_gex(ticker: str, expiration: str = None):
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

    loop = asyncio.get_event_loop()
    response = await loop.run_in_executor(
        None,                        # use the default ThreadPoolExecutor
        fetch_and_calculate_gex,     # the synchronous function to run
        ticker,                      # positional arg: ticker_symbol
        expiration                   # positional arg: target_expiration
    )

    if response.status == "error":
        raise HTTPException(status_code=400, detail=response.message)

    return response

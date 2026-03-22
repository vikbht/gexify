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
    """
    ticker = ticker.upper()  # normalise to uppercase (yfinance is case-sensitive)
    logger.info(f"Fetching expirations for {ticker}")

    response = fetch_expirations(ticker)

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

    Query params:
        expiration (str, optional): "YYYY-MM-DD" format.  Defaults to nearest expiry.
    """
    ticker = ticker.upper()  # normalise to uppercase
    logger.info(f"Fetching GEX for {ticker} (Exp: {expiration})")

    response = fetch_and_calculate_gex(ticker, target_expiration=expiration)

    if response.status == "error":
        raise HTTPException(status_code=400, detail=response.message)

    return response

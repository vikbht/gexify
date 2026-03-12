import asyncio
from fastapi import APIRouter, HTTPException, Path, Query
from app.models.gex import GexResponse, ExpirationResponse
from app.services.gex_calculator import fetch_history_sync, fetch_chain_sync, compute_gex_profile, fetch_term_structure, compute_total_market_gex
import logging

router = APIRouter()
logger = logging.getLogger(__name__)



@router.get("/gex/{ticker}/expirations", response_model=ExpirationResponse)
async def get_expirations(ticker: str = Path(..., pattern="^[A-Za-z]{1,5}$", description="Stock ticker symbol")):
    """
    Return all available options expiration dates & net GEX for a given ticker.
    """
    ticker = ticker.upper()  # normalise to uppercase
    logger.info(f"Fetching term structure expirations for {ticker}")

    loop = asyncio.get_running_loop()
    response = await loop.run_in_executor(None, fetch_term_structure, ticker)

    if response.status == "error":
        raise HTTPException(status_code=400, detail=response.message)

    return response


@router.get("/gex/{ticker}", response_model=GexResponse)
async def get_gex(
    ticker: str = Path(..., pattern="^[A-Za-z]{1,5}$", description="Stock ticker symbol"),
    expiration: str = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="Expiration date YYYY-MM-DD"),
    view_mode: str = "single",
    r: float = Query(0.04, ge=0.0, le=0.2, description="Risk-free rate (annualized, e.g. 0.04 for 4%)"),
):
    """
    Return the full Gamma Exposure (GEX) profile for a ticker.

    If view_mode == "single", it calculates GEX for a specific expiration date.
    If view_mode == "total", it calculates GEX for all upcoming expirations concurrently.
    """
    ticker = ticker.upper()  # normalise to uppercase
    logger.info(f"Fetching GEX for {ticker} (Exp: {expiration}, Mode: {view_mode}, r: {r})")

    loop = asyncio.get_running_loop()
    
    try:
        if view_mode == "total":
            logger.info("Total Market Mode: Fetching history and aggregating all option chains.")
            # History is still required for spot price and sparkline
            spot_price, historical_prices = await loop.run_in_executor(None, fetch_history_sync, ticker)
            
            # Run the heavy concurrent array-math function in the process pool
            response = await loop.run_in_executor(
                None,
                compute_total_market_gex,
                ticker, spot_price, historical_prices, r
            )
            return response
            
        else:
            # Original Single Expiration Logic
            history_task = loop.run_in_executor(None, fetch_history_sync, ticker)
            chain_task = loop.run_in_executor(None, fetch_chain_sync, ticker, expiration)
            
            (spot_price, historical_prices), (calls, puts, target_exp) = await asyncio.gather(history_task, chain_task)
            
            response = await loop.run_in_executor(
                None,
                compute_gex_profile,
                ticker, spot_price, historical_prices, calls, puts, target_exp, r
            )
            return response

    except Exception as e:
        logger.error(f"Error fetching GEX for {ticker}: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

from pydantic import BaseModel
from typing import List, Optional

class GexDataPoint(BaseModel):
    strike: float
    call_gex: float
    put_gex: float
    total_gex: float

class DexDataPoint(BaseModel):
    """Per-strike Delta Exposure — the directional hedging pressure dealers face."""
    strike: float
    call_dex: float   # N(d1) * OI * 100 * Spot  (always positive)
    put_dex: float    # (N(d1)-1) * OI * 100 * Spot  (always negative)
    total_dex: float  # call_dex + put_dex

class HistoricalPriceItem(BaseModel):
    date: str
    price: float

class GexResponse(BaseModel):
    ticker: str
    spot_price: float
    expiration_date: str
    gex_data: List[GexDataPoint]
    dex_data: List[DexDataPoint] = []
    historical_prices: List[HistoricalPriceItem] = []
    # GEX flip: strike where cumulative GEX crosses zero
    gex_flip_strike: Optional[float] = None
    # DEX flip: strike where cumulative DEX crosses zero
    dex_flip_strike: Optional[float] = None
    status: str = "success"
    message: str = ""

class ExpirationDetail(BaseModel):
    date: str
    net_gex: float

class ExpirationResponse(BaseModel):
    ticker: str
    expirations: List[ExpirationDetail]
    status: str = "success"
    message: str = ""

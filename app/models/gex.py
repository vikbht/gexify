from pydantic import BaseModel
from typing import List, Optional

class GexDataPoint(BaseModel):
    strike: float
    call_gex: float
    put_gex: float
    total_gex: float
    date: Optional[str] = None
    dom_call_strike: Optional[float] = None
    dom_put_strike: Optional[float] = None

class HistoricalPriceItem(BaseModel):
    date: str
    price: float

class GexResponse(BaseModel):
    ticker: str
    spot_price: float
    expiration_date: str
    gex_data: List[GexDataPoint]
    historical_prices: List[HistoricalPriceItem] = []
    # GEX flip: strike where cumulative GEX crosses zero
    gex_flip_strike: Optional[float] = None
    status: str = "success"
    message: str = ""

class ExpirationDetail(BaseModel):
    date: str
    call_gex: float = 0.0
    put_gex: float = 0.0
    net_gex: float
    dom_call_strike: Optional[float] = None
    dom_put_strike: Optional[float] = None

class ExpirationResponse(BaseModel):
    ticker: str
    expirations: List[ExpirationDetail]
    status: str = "success"
    message: str = ""

from pydantic import BaseModel
from typing import List, Optional

class GexDataPoint(BaseModel):
    strike: float
    call_gex: float
    put_gex: float
    total_gex: float

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
    net_gex: float

class ExpirationResponse(BaseModel):
    ticker: str
    expirations: List[ExpirationDetail]
    status: str = "success"
    message: str = ""

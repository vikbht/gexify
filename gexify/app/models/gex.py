from pydantic import BaseModel
from typing import List, Dict

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
    status: str = "success"
    message: str = ""

class ExpirationResponse(BaseModel):
    ticker: str
    expirations: List[str]
    status: str = "success"
    message: str = ""

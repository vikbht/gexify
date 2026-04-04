from unittest.mock import patch
from app.models.gex import ExpirationResponse, ExpirationDetail, GexResponse

@patch('app.api.endpoints.fetch_term_structure')
def test_get_expirations_success(mock_fetch_term_structure, client):
    # Setup mock data
    mock_fetch_term_structure.return_value = ExpirationResponse(
        ticker="AAPL",
        status="success",
        message="OK",
        expirations=[
            ExpirationDetail(date="2026-05-01", call_gex=100.0, put_gex=-50.0, net_gex=50.0, dom_call_strike=150.0, dom_put_strike=140.0)
        ]
    )

    response = client.get("/api/gex/AAPL/expirations")
    assert response.status_code == 200
    
    data = response.json()
    assert data["status"] == "success"
    assert len(data["expirations"]) == 1
    assert data["expirations"][0]["date"] == "2026-05-01"


@patch('app.api.endpoints.fetch_term_structure')
def test_get_expirations_error(mock_fetch_term_structure, client):
    # Setup mock data for an error scenario
    mock_fetch_term_structure.return_value = ExpirationResponse(
        ticker="XYZ",
        status="error",
        message="Ticker not found",
        expirations=[]
    )

    response = client.get("/api/gex/XYZ/expirations")
    assert response.status_code == 400
    
    data = response.json()
    assert data["detail"] == "Ticker not found"


@patch('app.api.endpoints.fetch_history_sync')
@patch('app.api.endpoints.fetch_chain_sync')
@patch('app.api.endpoints.compute_gex_profile')
def test_get_gex_single(mock_compute, mock_fetch_chain, mock_fetch_history, client):
    # Setup mock data
    mock_fetch_history.return_value = (150.0, [], "Apple Inc.")
    mock_fetch_chain.return_value = (None, None, "2026-05-01")  # Mock simplified calls/puts as None
    
    mock_compute.return_value = GexResponse(
        ticker="AAPL",
        spot_price=150.0,
        company_name="Apple Inc.",
        expiration_date="2026-05-01",
        gex_data=[],
        historical_prices=[],
        gex_flip_strike=145.0
    )

    response = client.get("/api/gex/AAPL", params={"expiration": "2026-05-01", "view_mode": "single", "r": 0.04})
    assert response.status_code == 200
    
    data = response.json()
    assert data["ticker"] == "AAPL"
    assert data["spot_price"] == 150.0
    assert data["expiration_date"] == "2026-05-01"

from app.services.gex_calculator import calculate_gamma
import pytest

def test_calculate_gamma():
    spot_price = 150.0
    strike = 150.0
    T = 30 / 365.25
    r = 0.04
    sigma = 0.20
    
    gamma = calculate_gamma(spot_price, strike, T, r, sigma)
    # Gamma of ATM option should be > 0
    assert gamma > 0
    
    # Degenerate case when T <= 0
    gamma_zero = calculate_gamma(spot_price, strike, 0, r, sigma)
    assert gamma_zero == 0.0

import pytest
from fastapi.testclient import TestClient
from app.main import app

@pytest.fixture
def client():
    """Fixture to provide a TestClient for the FastAPI app."""
    return TestClient(app)

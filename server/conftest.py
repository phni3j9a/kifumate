import pytest


@pytest.fixture(autouse=True)
def no_private_knowledge(monkeypatch, tmp_path):
    import coach_knowledge
    monkeypatch.setattr(coach_knowledge, 'DB_PATH', tmp_path / 'absent.json')

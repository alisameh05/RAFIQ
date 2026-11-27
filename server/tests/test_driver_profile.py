"""Profile contract tests against the same disposable roles as account entry."""

from test_accounts import ACCOUNT, accounts, published_conditions


def test_eligible_driver_can_update_only_their_own_display_name(accounts, published_conditions):
    client, session, _ = accounts
    subject, owner = session()
    _, other = session()
    assert client.patch(ACCOUNT, headers=owner, json={"displayName": "Before acceptance"}).json()["code"] == (
        "controlled_use_required"
    )
    for headers in (owner, other):
        assert client.put(ACCOUNT + "/controlled-use", headers=headers, json={
            "accepted": True, "version": "controlled-use-1",
        }).status_code == 200
    owner_id = client.get(ACCOUNT, headers=owner).json()["accountId"]
    other_id = client.get(ACCOUNT, headers=other).json()["accountId"]

    for payload in ({}, {"displayName": ""}, {"displayName": "a" * 101}, {"displayName": None},
                    {"displayName": "Name", "accountId": other_id},
                    {"displayName": "Name", "registeredEmail": "other@example.net"},
                    {"displayName": "Name", "verified": True}):
        response = client.patch(ACCOUNT, headers=owner, json=payload)
        assert response.status_code == 422
        assert response.json()["code"] == "validation_failed"
        assert "accountId" not in response.json()
    invalid_name = client.patch(ACCOUNT, headers=owner, json={"displayName": " "})
    assert invalid_name.json()["errors"] == [{"pointer": "/displayName", "code": "invalid"}]

    name_at_limit = "🌿" * 100
    assert client.patch(ACCOUNT, headers=owner, json={"displayName": name_at_limit}).json()["displayName"] == name_at_limit
    result = client.patch(ACCOUNT, headers=owner, json={"displayName": " 🌿 "})
    assert result.status_code == 200
    assert result.headers["cache-control"] == "private, no-store"
    assert result.json()["accountId"] == owner_id
    assert result.json()["displayName"] == "🌿"
    _, fresh = session(subject=subject)
    assert client.get(ACCOUNT, headers=fresh).json() == result.json()
    assert client.get(ACCOUNT, headers=other).json()["displayName"] is None


def test_profile_rejects_invalid_authority_and_allows_the_configured_patch_preflight(accounts):
    client, session, _ = accounts
    payload = {"displayName": "Driver"}
    for options, expected in (({"verified": False}, 403), ({"banned": True}, 403), ({"status": "revoked"}, 401)):
        _, headers = session(**options)
        response = client.patch(ACCOUNT, headers=headers, json=payload)
        assert response.status_code == expected
        assert "registeredEmail" not in response.json()
    assert client.patch(ACCOUNT, json=payload).status_code == 401
    preflight = client.options(ACCOUNT, headers={
        "Origin": "https://entry.example",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,content-type",
    })
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "https://entry.example"

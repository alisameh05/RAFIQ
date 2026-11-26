import base64
import json
import os
import time
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from svix.webhooks import Webhook

from fixture.database import engine_for, schema_ready
from fixture.identity import FixtureIdentity
from fixture.worker import CLAIM, PUBLISH, calculate

FIXTURES = "rafiq_fixture.fixtures"


class FixtureIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = engine_for("api")
        cls.worker = engine_for("worker")

    @classmethod
    def tearDownClass(cls):
        cls.api.dispose()
        cls.worker.dispose()

    def test_runtime_roles_have_scoped_grants_and_row_policies(self):
        with self.api.connect() as connection:
            self.assertTrue(schema_ready(connection, "api"))
            self.assertEqual(connection.execute(
                text(f"SELECT count(id) FROM {FIXTURES}")
            ).scalar_one(), 0)
            connection.execute(text("SELECT set_config('rafiq.fixture_owner', 'driver-a', true)"))
            self.assertEqual(connection.execute(
                text(f"SELECT owner_id FROM {FIXTURES}")
            ).scalars().all(), ["driver-a"])
            with self.assertRaises(ProgrammingError) as denied:
                connection.execute(text(f"INSERT INTO {FIXTURES} (owner_id) VALUES ('driver-b')"))
            self.assertEqual(denied.exception.orig.sqlstate, "42501")
            self.assertIn("row-level security policy", str(denied.exception.orig))

        with self.api.connect() as connection:
            self.assertEqual(connection.execute(
                text(f"SELECT count(id) FROM {FIXTURES}")
            ).scalar_one(), 0)
            with self.assertRaises(ProgrammingError) as denied:
                connection.execute(text(f"UPDATE {FIXTURES} SET result = NULL"))
            self.assertIn("permission denied", str(denied.exception.orig))

        with self.worker.connect() as connection:
            self.assertTrue(schema_ready(connection, "worker"))
            with self.assertRaises(ProgrammingError) as denied:
                connection.execute(text(f"SELECT owner_id FROM {FIXTURES}"))
            self.assertIn("permission denied", str(denied.exception.orig))

    def test_reclaimed_generation_is_the_only_one_that_can_publish(self):
        with self.api.begin() as connection:
            connection.execute(text("SELECT set_config('rafiq.fixture_owner', 'driver-b', true)"))
            connection.execute(text(f"INSERT INTO {FIXTURES} (owner_id) VALUES ('driver-b')"))
            fixture_id = connection.execute(text(f"SELECT id FROM {FIXTURES}")).scalar_one()

        with self.worker.begin() as connection:
            first = connection.execute(CLAIM, {"lease_seconds": 0}).mappings().one()
            self.assertEqual(first.id, fixture_id)

        result = calculate(first.samples)
        self.assertEqual(result.model_dump(), {
            "version": 1, "method": "synthetic-mean-v1", "count": 3, "mean": 4,
        })
        publication = {"id": fixture_id, "status": "completed", "result": result.model_dump_json()}
        with self.worker.begin() as connection:
            self.assertEqual(connection.execute(
                PUBLISH, {**publication, "generation": first.generation}
            ).rowcount, 0)

        with self.worker.begin() as connection:
            second = connection.execute(CLAIM, {"lease_seconds": 30}).mappings().one()
            self.assertEqual(second.id, fixture_id)
            self.assertEqual(second.generation, first.generation + 1)

            with self.worker.begin() as competing_worker:
                self.assertIsNone(competing_worker.execute(
                    CLAIM, {"lease_seconds": 30}
                ).mappings().one_or_none())

        with self.worker.begin() as connection:
            self.assertEqual(connection.execute(
                PUBLISH, {**publication, "generation": first.generation}
            ).rowcount, 0)
            self.assertEqual(connection.execute(
                PUBLISH, {**publication, "generation": second.generation}
            ).rowcount, 1)

        with self.worker.begin() as connection:
            self.assertEqual(connection.execute(
                PUBLISH, {**publication, "generation": second.generation}
            ).rowcount, 0)

        with self.api.begin() as connection:
            connection.execute(text("SELECT set_config('rafiq.fixture_owner', 'driver-b', true)"))
            self.assertEqual(connection.execute(
                text(f"SELECT result FROM {FIXTURES}")
            ).scalar_one(), result.model_dump())

    def test_validation_callback_receipts_are_durable_and_deduplicated(self):
        from fixture import api

        secret = "whsec_" + base64.b64encode(os.urandom(32)).decode()
        instance = "ins_synthetic"
        event_id = "msg_" + os.urandom(16).hex()
        now = datetime.now(timezone.utc)
        body = json.dumps({"object": "event", "type": "user.updated", "instance_id": instance,
                           "data": {"id": "user_synthetic"}}, separators=(",", ":"))

        def headers_for(payload):
            return {"svix-id": event_id, "svix-timestamp": str(int(now.timestamp())),
                    "svix-signature": Webhook(secret).sign(event_id, now, payload)}

        with patch.object(api, "identity", SimpleNamespace(mode="hosted-validation")), patch.dict(
            os.environ, {"CLERK_WEBHOOK_SIGNING_SECRET": secret, "CLERK_INSTANCE_ID": instance}
        ), TestClient(api.app) as client:
            path = "/validation/webhooks/clerk"
            self.assertEqual(client.post(path, content=body, headers=headers_for(body)).status_code, 204)
            self.assertEqual(client.post(path, content=body, headers=headers_for(body)).status_code, 204)
            changed = body + " "
            self.assertEqual(client.post(path, content=changed, headers=headers_for(changed)).status_code, 409)
            self.assertEqual(client.post(path, content=changed, headers=headers_for(body)).status_code, 400)

        with self.api.connect() as connection:
            count = connection.execute(text("""
                SELECT count(event_id) FROM rafiq_fixture.validation_callback_receipts WHERE event_id = :event_id
            """), {"event_id": event_id}).scalar_one()
            self.assertEqual(count, 1)
        with self.worker.connect() as connection:
            with self.assertRaises(ProgrammingError):
                connection.execute(text("SELECT event_id FROM rafiq_fixture.validation_callback_receipts"))

    def test_hosted_identity_reaches_rls_and_denies_other_owners(self):
        from fixture import api

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_key = key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()
        identity = FixtureIdentity.from_environment({
            "RAFIQ_MODE": "hosted-validation", "RAFIQ_WEB_ORIGIN": "https://fixture.example",
            "CLERK_ISSUER": "https://identity.example", "CLERK_JWT_KEY": public_key,
            "RAFIQ_VALIDATION_DRIVER_A": "user_test_a", "RAFIQ_VALIDATION_DRIVER_B": "user_test_b",
        })

        def authorization(subject):
            now = int(time.time())
            token = jwt.encode({"iss": identity.issuer, "azp": identity.web_origin, "sub": subject,
                                "sid": "sess_synthetic", "iat": now, "nbf": now - 1, "exp": now + 60},
                               key, algorithm="RS256")
            return {"Authorization": "Bearer " + token}

        with patch.object(api, "identity", identity), TestClient(api.app) as client:
            current = client.get("/api/v1/local-fixtures/current", headers=authorization("user_test_a"))
            self.assertEqual(current.status_code, 200)
            fixture_id = current.json()["id"]
            self.assertEqual(client.get(f"/api/v1/local-fixtures/{fixture_id}",
                                        headers=authorization("user_test_b")).status_code, 404)
            self.assertEqual(client.get(f"/api/v1/local-fixtures/{fixture_id}").status_code, 401)
            self.assertEqual(client.get(f"/api/v1/local-fixtures/{fixture_id}",
                                        headers={"Authorization": "Bearer local-driver-a"}).status_code, 401)
            self.assertEqual(client.get(f"/api/v1/local-fixtures/{fixture_id}",
                                        headers=authorization("user_other")).status_code, 401)
            with patch.object(api, "fetch_validation_object", return_value=b"synthetic") as fetch:
                path = "/validation/private-objects/driver-a"
                self.assertEqual(client.get(path, headers=authorization("user_test_b")).status_code, 404)
                self.assertEqual(client.get(path).status_code, 401)
                fetch.assert_not_called()
                result = client.get(path, headers=authorization("user_test_a"))
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.content, b"synthetic")
                self.assertEqual(fetch.call_count, 1)

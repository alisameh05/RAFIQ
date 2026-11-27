import time
import unittest

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from fixture.identity import FixtureIdentity


class HostedIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.public_key = cls.key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()

    def setUp(self):
        self.env = {
            "RAFIQ_MODE": "hosted-validation",
            "RAFIQ_WEB_ORIGIN": "https://fixture.example",
            "CLERK_ISSUER": "https://identity.example",
            "CLERK_JWT_KEY": self.public_key,
            "RAFIQ_VALIDATION_DRIVER_A": "user_test_a",
            "RAFIQ_VALIDATION_DRIVER_B": "user_test_b",
        }
        self.identity = FixtureIdentity.from_environment(self.env)

    def token(self, **changes):
        now = int(time.time())
        claims = {"iss": self.env["CLERK_ISSUER"], "sub": "user_test_a", "sid": "sess_test",
                  "azp": self.env["RAFIQ_WEB_ORIGIN"], "iat": now, "nbf": now - 1, "exp": now + 60}
        claims.update(changes)
        return "Bearer " + jwt.encode(claims, self.key, algorithm="RS256")

    def test_only_approved_signed_test_subjects_are_accepted(self):
        self.assertEqual(self.identity.owner_for(self.token()), "driver-a")
        self.assertEqual(self.identity.owner_for(self.token(sub="user_test_b")), "driver-b")
        self.assertIsNone(self.identity.owner_for(self.token(sub="user_unapproved")))
        self.assertIsNone(self.identity.owner_for("Bearer local-driver-a"))
        self.assertIsNone(self.identity.owner_for("Bearer invalid"))
        self.assertIsNone(self.identity.owner_for(None))

    def test_wrong_issuer_origin_expiry_or_session_are_denied(self):
        for changes in ({"iss": "https://other.example"}, {"azp": "https://other.example"},
                        {"exp": int(time.time()) - 1}, {"nbf": int(time.time()) + 60},
                        {"sid": ""}, {"exp": None}):
            with self.subTest(changes=changes):
                self.assertIsNone(self.identity.owner_for(self.token(**changes)))

    def test_signature_from_another_key_is_denied(self):
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = int(time.time())
        claims = {"iss": self.env["CLERK_ISSUER"], "sub": "user_test_a", "sid": "sess_test",
                  "azp": self.env["RAFIQ_WEB_ORIGIN"], "iat": now, "nbf": now, "exp": now + 60}
        self.assertIsNone(self.identity.owner_for("Bearer " + jwt.encode(claims, other, algorithm="RS256")))

    def test_hosted_configuration_fails_closed(self):
        for key in self.env:
            invalid = dict(self.env)
            invalid.pop(key)
            with self.subTest(key=key), self.assertRaises(ValueError):
                FixtureIdentity.from_environment(invalid)
        for origin in ("http://fixture.example", "https://fixture.example/path", "https://user@fixture.example"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                FixtureIdentity.from_environment({**self.env, "RAFIQ_WEB_ORIGIN": origin})
        with self.assertRaises(ValueError):
            FixtureIdentity.from_environment({**self.env, "RAFIQ_VALIDATION_DRIVER_B": "user_test_a"})
        for changes in ({"RAFIQ_VALIDATION_DRIVER_A": "../user_test_a"}, {"CLERK_JWT_KEY": "invalid"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                FixtureIdentity.from_environment({**self.env, **changes})

    def test_local_identity_is_only_available_in_local_mode(self):
        local = FixtureIdentity.from_environment({"RAFIQ_MODE": "local-fixture"})
        self.assertEqual(local.owner_for("Bearer local-driver-a"), "driver-a")
        self.assertIsNone(local.owner_for(self.token()))


if __name__ == "__main__":
    unittest.main()

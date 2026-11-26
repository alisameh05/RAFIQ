import unittest

from fixture.database import database_role, database_url


class DatabaseConfigurationTests(unittest.TestCase):
    def test_hosted_database_requires_hostname_verified_tls(self):
        valid = "postgresql+psycopg://test:synthetic@db.example/fixture?sslmode=verify-full&sslrootcert=system"
        self.assertEqual(database_url("hosted-validation", valid).query["sslmode"], "verify-full")
        for value in (
            "postgresql+psycopg://test:synthetic@db.example/fixture",
            "postgresql+psycopg://test:synthetic@db.example/fixture?sslmode=require&sslrootcert=system",
            "postgresql+psycopg://test:synthetic@db.example/fixture?sslmode=verify-full",
            "postgresql://test:synthetic@db.example/fixture?sslmode=verify-full&sslrootcert=system",
        ):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                database_url("hosted-validation", value)

    def test_local_mode_preserves_fixture_configuration(self):
        local = "postgresql+psycopg://test:synthetic@db/fixture"
        self.assertEqual(database_url("local-fixture", local).host, "db")
        with self.assertRaises(RuntimeError):
            database_url(None, local)

    def test_modes_use_distinct_expected_database_principals(self):
        self.assertEqual(database_role("local-fixture", "api"), "rafiq_api")
        self.assertEqual(database_role("hosted-validation", "api"), "rafiq_validation_api")
        self.assertEqual(database_role("hosted-validation", "worker"), "rafiq_validation_worker")
        self.assertEqual(database_role("hosted-validation", "migrate"), "rafiq_validation_migration")
        with self.assertRaises(RuntimeError):
            database_role("hosted-validation", "admin")


if __name__ == "__main__":
    unittest.main()

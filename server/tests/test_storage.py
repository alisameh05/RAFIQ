import unittest

import httpx

from fixture.storage import StorageDenied, StorageUnavailable, fetch_validation_object


class ValidationStorageTests(unittest.TestCase):
    def fetch(self, handler, **changes):
        args = {"origin": "https://project.supabase.co", "publishable_key": "sb_publishable_synthetic",
                "subject": "user_test_a", "token": "Bearer synthetic"}
        return fetch_validation_object(**{**args, **changes}, transport=httpx.MockTransport(handler))

    def test_private_object_uses_scoped_identity_and_bearer(self):
        def handler(request):
            self.assertEqual(request.url.path, "/storage/v1/object/authenticated/rafiq-validation-fixtures/user_test_a/private-access-check.txt")
            self.assertEqual(request.headers["Authorization"], "Bearer synthetic")
            self.assertEqual(request.headers["apikey"], "sb_publishable_synthetic")
            return httpx.Response(200, content=b"synthetic object")
        self.assertEqual(self.fetch(handler), b"synthetic object")

    def test_denial_redirect_and_oversized_response_are_not_exposed(self):
        for status in (400, 401, 403, 404):
            with self.subTest(status=status), self.assertRaises(StorageDenied):
                self.fetch(lambda _request: httpx.Response(status))
        with self.assertRaises(StorageUnavailable):
            self.fetch(lambda _request: httpx.Response(302, headers={"Location": "https://elsewhere.example"}))
        with self.assertRaises(StorageUnavailable):
            self.fetch(lambda _request: httpx.Response(200, content=b"x" * 1025))

    def test_untrusted_origin_or_non_publishable_key_fails_before_request(self):
        def unexpected(_request):
            self.fail("A request must not be sent")
        for changes in ({"origin": "http://project.supabase.co"}, {"origin": "https://evil.example"},
                        {"origin": "https://project.supabase.co/path"}, {"publishable_key": "secret"}):
            with self.subTest(changes=changes), self.assertRaises(StorageUnavailable):
                self.fetch(unexpected, **changes)


if __name__ == "__main__":
    unittest.main()

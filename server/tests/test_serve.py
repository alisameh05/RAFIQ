import unittest

from fixture.serve import server_port


class ServerPortTests(unittest.TestCase):
    def test_default_and_assigned_port(self):
        self.assertEqual(server_port(None), 8000)
        self.assertEqual(server_port("12345"), 12345)


    def test_invalid_port_is_rejected(self):
        for value in ("", "0", "65536", "-1", "80.0", "１２３", " 8000"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                server_port(value)

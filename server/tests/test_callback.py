import base64
import json
import os
import unittest
from datetime import datetime, timedelta, timezone

from svix.webhooks import Webhook

from fixture.callback import InvalidCallback, verify_callback


class CallbackVerificationTests(unittest.TestCase):
    def setUp(self):
        self.secret = "whsec_" + base64.b64encode(os.urandom(32)).decode()
        self.instance = "ins_synthetic"
        self.event = {"object": "event", "instance_id": self.instance, "type": "user.updated", "data": {}}

    def signed(self, event=None, secret=None, when=None):
        body = json.dumps(event or self.event, separators=(",", ":"))
        when = when or datetime.now(timezone.utc)
        event_id = "msg_synthetic"
        signature = Webhook(secret or self.secret).sign(event_id, when, body)
        return body.encode(), {"svix-id": event_id, "svix-timestamp": str(int(when.timestamp())),
                               "svix-signature": signature}

    def test_valid_signature_and_replay_have_the_same_receipt(self):
        body, headers = self.signed()
        receipt = verify_callback(body, headers, self.secret, self.instance)
        self.assertEqual(receipt, verify_callback(body, headers, self.secret, self.instance))
        self.assertEqual(receipt[0], "msg_synthetic")
        self.assertEqual(len(receipt[1]), 64)

    def test_invalid_signature_wrong_instance_and_stale_timestamp_are_rejected(self):
        body, headers = self.signed()
        with self.assertRaises(InvalidCallback):
            verify_callback(body + b" ", headers, self.secret, self.instance)
        with self.assertRaises(InvalidCallback):
            verify_callback(body, headers, self.secret, "ins_other")
        body, headers = self.signed(when=datetime.now(timezone.utc) - timedelta(minutes=10))
        with self.assertRaises(InvalidCallback):
            verify_callback(body, headers, self.secret, self.instance)

    def test_non_identity_event_and_invalid_event_id_are_rejected(self):
        body, headers = self.signed({**self.event, "type": "session.created"})
        with self.assertRaises(InvalidCallback):
            verify_callback(body, headers, self.secret, self.instance)
        body, headers = self.signed()
        headers["svix-id"] = "../invalid"
        with self.assertRaises(InvalidCallback):
            verify_callback(body, headers, self.secret, self.instance)


if __name__ == "__main__":
    unittest.main()

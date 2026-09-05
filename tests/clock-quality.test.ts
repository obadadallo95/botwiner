import assert from "node:assert/strict";
import test from "node:test";
import { decodeNtpUnixMs } from "@botwiner/solana";

test("decodes an NTP fixed-point timestamp into Unix milliseconds", () => {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32BE(2_208_988_800 + 1_780_000_000, 40);
  bytes.writeUInt32BE(0x8000_0000, 44);
  assert.equal(decodeNtpUnixMs(bytes, 40), 1_780_000_000_500);
});

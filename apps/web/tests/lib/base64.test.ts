import { expect, test } from "vitest";

import { decodeBase64 } from "@/lib/base64";

test("decodes base64 to the exact bytes, including high bytes", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const encoded = Buffer.from(bytes).toString("base64");
  expect(decodeBase64(encoded)).toEqual(bytes);
  expect(decodeBase64("")).toEqual(new Uint8Array());
});

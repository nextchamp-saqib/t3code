import { assert, it } from "@effect/vitest";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

it("treats nightly versions with build metadata as nightly", () => {
  assert.isTrue(isNightlyDesktopVersion("0.1.3-nightly.20261026.3710"));
  assert.isTrue(isNightlyDesktopVersion("0.1.3-nightly.20261026.3710+mine.7e8dbb9f2c"));
  assert.isFalse(isNightlyDesktopVersion("0.1.3+mine.7e8dbb9f2c"));
});

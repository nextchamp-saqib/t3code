import { assert, it } from "@effect/vitest";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

it("treats nightly versions with build metadata as nightly", () => {
  for (const version of [
    "0.1.3-nightly.20261026.3710",
    "0.1.3-nightly.20261026.3710+mine.7e8dbb9f2c",
  ]) {
    assert.isTrue(isNightlyDesktopVersion(version), version);
    assert.equal(resolveDefaultDesktopUpdateChannel(version), "nightly");
  }
  assert.isFalse(isNightlyDesktopVersion("0.1.3+mine.7e8dbb9f2c"));
  assert.equal(resolveDefaultDesktopUpdateChannel("0.1.3+mine.7e8dbb9f2c"), "latest");
  assert.equal(
    resolveDefaultDesktopUpdateChannel("0.1.3-preview.20261026.3710+mine.7e8dbb9f2c"),
    "latest",
  );
});

import { expect, test } from "bun:test";
import { jdepsClassEntries } from "../src/freerouting-runtime";

test("jdeps extracts class files only, without dependency module descriptors", () => {
  const listing = [
    "META-INF/",
    "META-INF/LICENSE",
    "META-INF/license/",
    "META-INF/license/LICENSE.boringssl.txt",
    "module-info.class",
    "META-INF/versions/11/module-info.class",
    "META-INF/versions/11/com/x/Y.class",
    "app/freerouting/Freerouting.class",
    "app/freerouting/Gui$1.class",
    "",
  ].join("\r\n");
  expect(jdepsClassEntries(listing)).toEqual([
    "META-INF/versions/11/com/x/Y.class",
    "app/freerouting/Freerouting.class",
    "app/freerouting/Gui$1.class",
  ]);
});

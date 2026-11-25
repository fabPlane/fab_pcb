import { describe, expect, test } from "bun:test";
import { RuleSeverity } from "@fp-pcb/proto";
import { ercErrorDetail } from "../src/erc-detail";

const marker = (description: string, severity = RuleSeverity.RS_ERROR, excluded = false) => ({ description, severity, excluded });

describe("ercErrorDetail", () => {
  test("quotes errors only, in order", () => {
    const markers = [
      marker("Symbol 'U1' doesn't match copy in library 'Ref'", RuleSeverity.RS_WARNING),
      marker("Pin not connected"),
      marker("The current configuration does not include the footprint library 'Ref'", RuleSeverity.RS_WARNING),
      marker("Input Power pin not driven by any Output Power pins"),
    ];
    expect(ercErrorDetail(markers)).toBe("Pin not connected; Input Power pin not driven by any Output Power pins");
  });

  test("skips excluded and ignored markers", () => {
    expect(ercErrorDetail([marker("Pin not connected", RuleSeverity.RS_ERROR, true), marker("Unused", RuleSeverity.RS_IGNORE)])).toBe("");
  });

  test("warnings do not use up the limit, and the remainder is counted", () => {
    const markers = [
      ...Array.from({ length: 20 }, (_, i) => marker(`warning ${i}`, RuleSeverity.RS_WARNING)),
      ...Array.from({ length: 12 }, (_, i) => marker(`error ${i}`)),
    ];
    expect(ercErrorDetail(markers)).toBe(`${Array.from({ length: 10 }, (_, i) => `error ${i}`).join("; ")}; and 2 more`);
  });
});

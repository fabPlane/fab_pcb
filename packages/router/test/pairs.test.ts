import { test, expect } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { NetClassSchema } from "@fp-pcb/proto";
import { toDistance, mm } from "@fp-pcb/client";
import { detectDifferentialPairs } from "../src/pairs";
import { applyRequestRules } from "../src/request-rules";
import { twoNetBoard } from "./fixtures";
test("detects standard suffixes without treating arbitrary trailing P/N names as pairs",()=>{
 expect(detectDifferentialPairs(["A_P","A_N","B+","B-","USB_DP","USB_DN","C_DP","C_DN","EEP","EEN","ONLY_P"])).toEqual([{p:"A_P",n:"A_N"},{p:"B+",n:"B-"},{p:"USB_DP",n:"USB_DN"},{p:"C_DP",n:"C_DN"}]);
});
test("native netclass dimensions are retained and explicit requests take precedence",()=>{
 const cls=create(NetClassSchema,{name:"differential",board:{diffPairTrackWidth:toDistance(mm(0.25)),diffPairGap:toDistance(mm(0.2))}});
 const pairs=detectDifferentialPairs(["X_P","X_N"],new Map([["X_P",cls],["X_N",cls]]));
 expect(pairs).toEqual([{p:"X_P",n:"X_N",widthMm:0.25,gapMm:0.2}]);
 const input=twoNetBoard();input.differentialPairs=[{p:"A",n:"B",widthMm:0.25,gapMm:0.2}];
 applyRequestRules(input,{perNet:[{net:"A",widthMm:0.3}]});
 expect(input.differentialPairs).toEqual([{p:"A",n:"B",widthMm:0.25,gapMm:0.2}]);
 expect(input.rules.perNet.get("A")!.trackWidth).toBe(mm(0.3));
 applyRequestRules(input,{differentialPairs:[{p:"A",n:"B",widthMm:0.3}]});
 expect(input.differentialPairs).toEqual([{p:"A",n:"B",widthMm:0.3}]);
});

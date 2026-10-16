// SPDX-License-Identifier: GPL-3.0-only
import {pathToFileURL} from 'node:url';
const {routeDsn} = await import(pathToFileURL(process.env.FAB_ROUTER_MODULE ?? `${import.meta.dir}/../runtime/c/fab-router-source/src/api.ts`).href);
const [work,seed,cap,settingsFile]=process.argv.slice(2);
const manifest=await Bun.file(`${work}/dsn-manifest.json`).json();
const candidate=await Bun.file(settingsFile).json();
const settings={timeBudgetMs:Number(cap)*1000,maxPasses:100,seed:Number(seed),
 copperToEdgeClearanceUm:manifest.native_rules.min_copper_edge_clearance*1000,
 holeClearanceUm:manifest.native_rules.min_hole_clearance*1000,
 strictDrc:true,neckWidthUm:0,fanoutEnabled:false,ignoreNetGroups:manifest.ignore_classes,
 ...candidate.settings};
const result=routeDsn(await Bun.file(`${work}/board.dsn`).text(),settings);
await Bun.write(`${work}/router-summary.json`,JSON.stringify({settings,result},null,2)+'\n');
if(!result.ok)throw new Error(JSON.stringify(result.error));
await Bun.write(`${work}/board.ses`,result.ses);

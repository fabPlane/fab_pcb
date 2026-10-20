Cycle 76 measures the same 180 compatible attempts on the same machine, three fresh repeats, 10 seconds per attempt, nice 10, cores 0–5. No completion cache reuse, retries or discarded attempts. All seven compares and the runtime endpoint check pass. Source endpoints match the retained snapshot; this does not prove atomic execution or loaded dependency identity. Central native baseline adoption remains unresolved.

|Suite|Router|Before completed|After completed|Before passes|After passes|Attempts each|
|---|---|---:|---:|---:|---:|---:|
|keepout-control|fab_router|0|0|0|0|3|
|keepout-control|reference engine|0|0|0|0|3|
|keepout-control|in-repo router|0|0|0|0|3|
|keepout-candidate|fab_router|0|0|0|0|3|
|keepout-candidate|reference engine|0|0|0|0|3|
|keepout-candidate|in-repo router|0|0|0|0|3|
|canary|fab_router|12|12|9|9|12|
|canary|reference engine|9|9|6|6|9|
|canary|capacity-mesh router|3|3|3|3|3|
|canary|in-repo router|12|12|3|3|12|
|bga|fab_router|0|0|0|0|12|
|bga|reference engine|0|0|0|0|6|
|bga|capacity-mesh router|0|0|0|0|6|
|bga|in-repo router|0|0|0|0|12|
|ladder|fab_router|3|5|3|3|18|
|ladder|reference engine|3|3|3|3|9|
|ladder|capacity-mesh router|6|6|6|6|9|
|ladder|in-repo router|7|9|0|0|18|
|dense-source|fab_router|0|0|0|0|3|
|dense-source|reference engine|0|0|0|0|3|
|dense-source|in-repo router|0|0|0|0|3|
|dense-candidate|fab_router|0|0|0|0|9|
|dense-candidate|reference engine|0|0|0|0|9|
|dense-candidate|in-repo router|0|0|0|0|9|

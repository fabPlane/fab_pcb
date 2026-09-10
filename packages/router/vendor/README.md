# vendor/

`freerouting-<version>.jar` lives here and is **not** checked in (see `.gitignore`). Download it
with `bun run bench/fetch-freerouting.ts` or by hand from
https://github.com/freerouting/freerouting/releases — see `../README.md`, "Freerouting".

For a portable backend bundle, pass the downloaded assets to `packages/kicad-patches/bundle.ts`
with `FP_PCB_FREEROUTING_JAR_SOURCE` and `FP_PCB_JAVA_HOME_SOURCE`. The resulting manifest records
bundle-relative paths so Fabdesk can set `FREEROUTING_JAR` and `FP_PCB_JAVA` for the bridge.

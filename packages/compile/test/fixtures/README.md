# Compiler fixtures

`stock-multiunit-symbols.json` contains effective stock KiCad symbol definitions captured through
`GetLibraryItem` from KiCad 10.99.0-4517-g329aba9ff, using the combined evaluation bundle's stock
libraries on 2026-10-14. Symbols: LM358, LM324, LM393, 74HC00 and NE556. Each protobuf definition
is stored as base64 in JSON so inherited pins, common pins and alternate body styles are preserved.
KiCad library licensing: https://www.kicad.org/libraries/license/ (CC-BY-SA 4.0 with exception).
These frozen test inputs must not substitute for integration checks against actual stock libraries.

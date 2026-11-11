from pathlib import Path
import re
out = Path(__file__).parent
counts = {}
for phase in ["before", "after"]:
    values = []
    for repeat in range(1, 4):
        log = (out / f"{phase}-{repeat}.log").read_text()
        passed = int(re.search(r"(\d+) pass", log)[1])
        failed = int(re.search(r"(\d+) fail", log)[1])
        assert passed + failed == 4
        values.append(passed)
    assert len(set(values)) == 1
    counts[phase] = values[0]
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="360"><rect width="1000" height="360" fill="#f7f9fc"/><g font-family="sans-serif" fill="#172b4d">'
svg += '<text x="35" y="48" font-size="25">Via stack order: 4 cases × 3 repeats</text><text x="35" y="90" font-size="18">Same cases and host • passing cases per repeat</text>'
for phase, y, color in [("before", 125, "#d9822b"), ("after", 205, "#23856d")]:
    count = counts[phase]
    svg += f'<text x="35" y="{y+32}" font-size="22">{phase.title()}</text><rect x="180" y="{y}" width="{count*90}" height="48" fill="{color}"/><text x="{200+count*90}" y="{y+32}" font-size="22">{count} / 4</text>'
svg += '<text x="35" y="300" font-size="18">Normalize layer declarations before selecting native drill endpoints.</text><text x="35" y="330" font-size="16">Import diagnostics only; native thermal failures remain unresolved.</text></g></svg>'
(out / "comparison.svg").write_text(svg)

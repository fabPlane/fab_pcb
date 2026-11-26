"""Build an alternate J1 configuration without editing frozen benchmark settings."""
import json, shutil, sys
from pathlib import Path
benchmark=Path(sys.argv[1]).resolve()
dest=Path(sys.argv[2]).resolve()
shutil.copytree(benchmark/'configs',dest)  # Fail rather than overwrite a previous run.
p=dest/'fab-router.json'
config=json.loads(p.read_text())
command=config['jobs']['J1']['command']
settings_path=command[command.index('--settings-file')+1].replace('{benchmark}',str(benchmark))
settings=json.loads(Path(settings_path).read_text())
settings['settings']['extendedSearchBudget']=True
out=dest/'extended-settings.json'
out.write_text(json.dumps(settings,indent=2)+'\n')
command[command.index('--settings-file')+1]=str(out)
p.write_text(json.dumps(config,indent=2)+'\n')

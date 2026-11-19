"""Sample process-tree CPU use without applying resource limits."""
import os,pathlib,time
class Telemetry:
 def __init__(self):self.peak_threads=0;self.cpus=set();self.ticks={};self.first={}
 def sample(self,pids):
  threads=0
  for pid in pids:
   try:tasks=list(pathlib.Path('/proc',str(pid),'task').iterdir())
   except OSError:continue
   threads+=len(tasks)
   for t in tasks:
    try:
     fields=(t/'stat').read_text().rsplit(')',1)[1].split();key=(pid,int(t.name),fields[19]);ticks=int(fields[11])+int(fields[12])
     self.cpus.add(int(fields[36]));self.first.setdefault(key,ticks);self.ticks[key]=ticks
    except (OSError,ValueError,IndexError):pass
  self.peak_threads=max(self.peak_threads,threads)
 def result(self,wall):
  cpu=sum(self.ticks[k]-self.first[k] for k in self.ticks)/os.sysconf('SC_CLK_TCK')
  return {'peak_tree_threads_sampled':self.peak_threads,'observed_cpu_ids':sorted(self.cpus),'cpu_seconds_sampled':cpu,'mean_cpu_percent_sampled':100*cpu/wall if wall else 0,'cpu_sampling_boundary':'100ms; first sample subtracted; short-lived threads/processes may be missed'}
def machine():
 freqs={}
 for p in pathlib.Path('/sys/devices/system/cpu').glob('cpu[0-9]*/cpufreq/scaling_cur_freq'):
  try:freqs[p.parents[1].name]=int(p.read_text())
  except OSError:pass
 mem={k:int(v.split()[0]) for k,v in (x.split(':',1) for x in pathlib.Path('/proc/meminfo').read_text().splitlines()) if k in ['MemTotal','MemAvailable']}
 return {'utc':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'load_average':list(os.getloadavg()),'cpu_frequency_khz':freqs,'memory_kib':mem}

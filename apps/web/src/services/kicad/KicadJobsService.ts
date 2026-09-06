// JobsService over the RunBoardJobExport* / RunSchematicJobExport* commands. Every run
// writes into `<project dir>/kicad-web-out/<job>-<n>/` (inside the bridge workspace root, so
// `/files/list` can enumerate the outputs and `/files/read` can serve them) and reports the
// files KiCad returned in `RunJobResponse.output_path` plus whatever appeared in the folder.
//
// Jobs are started with `async` so KiCad answers at once (JS_RUNNING + job id, KiCad >= 11) and
// `Job.wait` polls GetJobStatus (JobProgress events wake it) into `JobRun.progress` / `log`; a
// server that runs jobs synchronously just returns the finished result. `RunSchematicJobExportNetlist`
// used to wedge the headless server; that is fixed in web-api 022e45f6d2+.

import { BoardLayer, Board3DFormat, DrillFormat, DrillMapFormat, DrillOrigin, GerberPrecision, Ipc2581Version, JobStatus, OdbCompression, PositionSide, SchematicNetlistFormat, Units } from '@kicad-web/proto';
import { JobError, type JobOptions, type JobResult } from '@kicad-web/client';

/** Every job runs async when the server supports it; see the header. */
const JOB: JobOptions = { async: true };
import type { JobDefinition, JobOutput, JobRun, JobsService } from '../types';
import type { KicadDocumentService } from './KicadDocumentService';
import type { KicadSessionService } from './KicadSessionService';

const COPPER_AND_TECH = ['BL_F_Cu', 'BL_In1_Cu', 'BL_In2_Cu', 'BL_In3_Cu', 'BL_In4_Cu', 'BL_B_Cu', 'BL_F_SilkS', 'BL_B_SilkS', 'BL_F_Mask', 'BL_B_Mask', 'BL_F_Paste', 'BL_B_Paste', 'BL_Edge_Cuts', 'BL_F_Fab', 'BL_B_Fab', 'BL_F_CrtYd', 'BL_B_CrtYd', 'BL_Dwgs_User', 'BL_Cmts_User'];

const layerChoices = (ids: readonly string[]) => ids.map((l) => ({ value: l, label: l.replace('BL_', '').replace(/_/g, '.') }));

export function jobDefinitions(enabledLayers: readonly string[]): JobDefinition[] {
  const layers = enabledLayers.length ? COPPER_AND_TECH.filter((l) => enabledLayers.includes(l)) : COPPER_AND_TECH;
  return [
    {
      id: 'board.svg',
      title: 'SVG plot',
      description: 'Vector plot of the selected layers (RunBoardJobExportSvg).',
      document: 'board',
      command: 'RunBoardJobExportSvg',
      options: [
        { key: 'layers', label: 'Layers', type: 'layers', default: ['BL_F_Cu', 'BL_F_SilkS', 'BL_Edge_Cuts'].filter((l) => layers.includes(l)), choices: layerChoices(layers) },
        { key: 'blackAndWhite', label: 'Black and white', type: 'boolean', default: false },
        { key: 'mirror', label: 'Mirror', type: 'boolean', default: false },
        { key: 'fitPageToBoard', label: 'Fit page to board', type: 'boolean', default: true },
      ],
    },
    {
      id: 'board.gerbers',
      title: 'Gerbers',
      description: 'Plot copper, mask, paste, silkscreen and edge layers as RS-274X (RunBoardJobExportGerbers).',
      document: 'board',
      command: 'RunBoardJobExportGerbers',
      options: [
        { key: 'layers', label: 'Layers', type: 'layers', default: layers.filter((l) => /_Cu$|Mask|Paste|SilkS|Edge_Cuts/.test(l)), choices: layerChoices(layers) },
        { key: 'useProtelExtensions', label: 'Use Protel filename extensions', type: 'boolean', default: false },
        { key: 'includeNetlistAttributes', label: 'Include netlist attributes (X2)', type: 'boolean', default: true },
        { key: 'createGerberJobFile', label: 'Create job file (.gbrjob)', type: 'boolean', default: true },
        { key: 'precision', label: 'Coordinate format', type: 'select', default: '4.6', choices: [{ value: '4.5', label: '4.5 (unit mm)' }, { value: '4.6', label: '4.6 (unit mm)' }] },
      ],
    },
    {
      id: 'board.drill',
      title: 'Drill files',
      description: 'Excellon drill files plus an optional drill map (RunBoardJobExportDrill).',
      document: 'board',
      command: 'RunBoardJobExportDrill',
      options: [
        { key: 'format', label: 'Format', type: 'select', default: 'excellon', choices: [{ value: 'excellon', label: 'Excellon' }, { value: 'gerber', label: 'Gerber X2' }] },
        { key: 'units', label: 'Units', type: 'select', default: 'mm', choices: [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }] },
        { key: 'generateMap', label: 'Generate drill map (PDF)', type: 'boolean', default: false },
        { key: 'origin', label: 'Drill origin', type: 'select', default: 'absolute', choices: [{ value: 'absolute', label: 'Absolute' }, { value: 'plot', label: 'Drill/place file origin' }] },
      ],
    },
    {
      id: 'board.position',
      title: 'Component placement (pick and place)',
      description: 'Placement file with reference, value, footprint, position and rotation (RunBoardJobExportPosition).',
      document: 'board',
      command: 'RunBoardJobExportPosition',
      options: [
        { key: 'units', label: 'Units', type: 'select', default: 'mm', choices: [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }] },
        { key: 'side', label: 'Side', type: 'select', default: 'both', choices: [{ value: 'front', label: 'Front' }, { value: 'back', label: 'Back' }, { value: 'both', label: 'Both' }] },
        { key: 'smdOnly', label: 'SMD footprints only', type: 'boolean', default: false },
        { key: 'excludeDnp', label: 'Exclude DNP', type: 'boolean', default: true },
      ],
    },
    {
      id: 'board.pdf',
      title: 'Board PDF',
      description: 'PDF plot of the selected layers (RunBoardJobExportPdf).',
      document: 'board',
      command: 'RunBoardJobExportPdf',
      options: [
        { key: 'layers', label: 'Layers', type: 'layers', default: ['BL_F_Cu', 'BL_F_SilkS', 'BL_Edge_Cuts'].filter((l) => layers.includes(l)), choices: layerChoices(layers) },
        { key: 'blackAndWhite', label: 'Black and white', type: 'boolean', default: false },
      ],
    },
    {
      id: 'board.step',
      title: 'STEP 3D model',
      description: 'Export the board with 3D models as STEP (RunBoardJobExport3D, B3D_STEP).',
      document: 'board',
      command: 'RunBoardJobExport3D',
      options: [
        { key: 'substituteModels', label: 'Substitute STEP for VRML models', type: 'boolean', default: true },
        { key: 'includeDnp', label: 'Include DNP', type: 'boolean', default: false },
        { key: 'includeUnspecified', label: 'Include unspecified footprints', type: 'boolean', default: true },
        { key: 'exportTracksAndVias', label: 'Export tracks and vias', type: 'boolean', default: false },
        { key: 'exportZones', label: 'Export zones', type: 'boolean', default: false },
        { key: 'fuseShapes', label: 'Fuse shapes', type: 'boolean', default: false },
        { key: 'optimizeStep', label: 'Optimize STEP', type: 'boolean', default: true },
        { key: 'origin', label: 'Origin', type: 'select', default: 'center', choices: [{ value: 'center', label: 'Board centre' }, { value: 'grid', label: 'Grid origin' }, { value: 'drill', label: 'Drill/place origin' }] },
      ],
    },
    {
      id: 'board.glb',
      title: 'GLB 3D model (3D viewer)',
      description: 'Binary glTF of the board with 3D models, what the 3D tab shows (RunBoardJobExport3D, B3D_GLB).',
      document: 'board',
      command: 'RunBoardJobExport3D',
      options: [
        { key: 'substituteModels', label: 'Substitute STEP for VRML models', type: 'boolean', default: true },
        { key: 'includeDnp', label: 'Include DNP', type: 'boolean', default: false },
        { key: 'exportTracksAndVias', label: 'Export tracks and vias', type: 'boolean', default: true },
        { key: 'exportZones', label: 'Export zones', type: 'boolean', default: true },
        { key: 'exportSilkscreen', label: 'Export silkscreen', type: 'boolean', default: true },
        { key: 'exportSoldermask', label: 'Export solder mask', type: 'boolean', default: true },
      ],
    },
    {
      id: 'board.ipc2581',
      title: 'IPC-2581',
      description: 'IPC-2581 XML assembly/fabrication data (RunBoardJobExportIpc2581).',
      document: 'board',
      command: 'RunBoardJobExportIpc2581',
      options: [
        { key: 'units', label: 'Units', type: 'select', default: 'mm', choices: [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }] },
        { key: 'version', label: 'Version', type: 'select', default: 'C', choices: [{ value: 'B', label: 'IPC-2581 B' }, { value: 'C', label: 'IPC-2581 C' }] },
        { key: 'precision', label: 'Precision (digits)', type: 'number', default: 3 },
        { key: 'compress', label: 'Compress (zip)', type: 'boolean', default: false },
        { key: 'bomRevision', label: 'BOM revision', type: 'string', default: '' },
        { key: 'mpnColumn', label: 'Manufacturer part number field', type: 'string', default: '' },
        { key: 'manufacturerColumn', label: 'Manufacturer field', type: 'string', default: '' },
      ],
    },
    {
      id: 'board.odb',
      title: 'ODB++',
      description: 'ODB++ fabrication data (RunBoardJobExportODB).',
      document: 'board',
      command: 'RunBoardJobExportODB',
      options: [
        { key: 'units', label: 'Units', type: 'select', default: 'mm', choices: [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }] },
        { key: 'precision', label: 'Precision (digits)', type: 'number', default: 2 },
        { key: 'compression', label: 'Compression', type: 'select', default: 'zip', choices: [{ value: 'none', label: 'None (directory)' }, { value: 'zip', label: 'ZIP' }, { value: 'tgz', label: 'TGZ' }] },
      ],
    },
    {
      id: 'board.dxf',
      title: 'DXF',
      description: 'DXF plot of the selected layers (RunBoardJobExportDxf).',
      document: 'board',
      command: 'RunBoardJobExportDxf',
      options: [{ key: 'layers', label: 'Layers', type: 'layers', default: ['BL_Edge_Cuts', 'BL_F_SilkS'].filter((l) => layers.includes(l)), choices: layerChoices(layers) }],
    },
    {
      id: 'schematic.svg',
      title: 'Schematic SVG',
      description: 'One SVG per sheet (RunSchematicJobExportSvg).',
      document: 'schematic',
      command: 'RunSchematicJobExportSvg',
      options: [
        { key: 'blackAndWhite', label: 'Black and white', type: 'boolean', default: false },
        { key: 'plotDrawingSheet', label: 'Plot drawing sheet (frame)', type: 'boolean', default: true },
      ],
    },
    {
      id: 'schematic.pdf',
      title: 'Schematic PDF',
      description: 'All sheets as a single PDF (RunSchematicJobExportPdf).',
      document: 'schematic',
      command: 'RunSchematicJobExportPdf',
      options: [
        { key: 'blackAndWhite', label: 'Black and white', type: 'boolean', default: false },
        { key: 'plotDrawingSheet', label: 'Plot drawing sheet (frame)', type: 'boolean', default: true },
        { key: 'hierarchicalLinks', label: 'Hierarchical links', type: 'boolean', default: true },
      ],
    },
    {
      id: 'schematic.netlist',
      title: 'Netlist',
      description: 'KiCad s-expression netlist (RunSchematicJobExportNetlist).',
      document: 'schematic',
      command: 'RunSchematicJobExportNetlist',
      options: [{ key: 'format', label: 'Format', type: 'select', default: 'sexpr', choices: [{ value: 'sexpr', label: 'KiCad s-expression' }, { value: 'xml', label: 'KiCad XML' }] }],
    },
    {
      id: 'schematic.bom',
      title: 'Bill of materials',
      description: 'CSV BOM (RunSchematicJobExportBOM).',
      document: 'schematic',
      command: 'RunSchematicJobExportBOM',
      options: [
        { key: 'excludeDnp', label: 'Exclude DNP', type: 'boolean', default: true },
        { key: 'groupSymbols', label: 'Group symbols', type: 'boolean', default: true },
      ],
    },
  ];
}

const layerEnum = (id: string): BoardLayer | undefined => BoardLayer[id as keyof typeof BoardLayer] as BoardLayer | undefined;
const layerEnums = (ids: unknown): BoardLayer[] => (Array.isArray(ids) ? ids.map((l) => layerEnum(String(l))).filter((l): l is BoardLayer => typeof l === 'number') : []);

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return (
    { svg: 'image/svg+xml', pdf: 'application/pdf', csv: 'text/csv', pos: 'text/plain', drl: 'text/plain', gbr: 'application/vnd.gerber', gbrjob: 'application/json', step: 'model/step', glb: 'model/gltf-binary', xml: 'application/xml', txt: 'text/plain' }[ext] ?? 'application/octet-stream'
  );
}

export class KicadJobsService implements JobsService {
  private runList: JobRun[] = [];
  private subs = new Set<() => void>();
  private seq = 1;

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly session: KicadSessionService,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  jobs(): JobDefinition[] {
    return jobDefinitions(this.docs.enabledLayerIds);
  }

  runs(): JobRun[] {
    return this.runList;
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private emit(): void {
    this.runList = [...this.runList];
    for (const cb of this.subs) cb();
  }

  clearFinished(): void {
    this.runList = this.runList.filter((r) => r.state === 'running' || r.state === 'queued');
    this.emit();
  }

  /** Output folder for a run: inside the project directory so the bridge can list it. */
  private outputDir(jobId: string, runId: string): string {
    const projectDir = (this.docs.project?.path || this.session.session?.projectPath.replace(/\/[^/]*$/, '') || this.session.workspaceRoot()).replace(/\/$/, '');
    return `${projectDir}/kicad-web-out/${jobId.replace('.', '-')}-${runId}`;
  }

  async run(jobId: string, options: Record<string, unknown>): Promise<JobRun> {
    const def = this.jobs().find((j) => j.id === jobId);
    if (!def) throw new Error(`Unknown job ${jobId}`);
    if (def.unavailable) throw new Error(`${def.title}: ${def.unavailable}`);
    const run: JobRun = { id: `run-${this.seq++}`, jobId, title: def.title, startedAt: Date.now(), state: 'queued', progress: 0, log: [`${def.command} ${JSON.stringify(options)}`], outputs: [] };
    this.runList = [run, ...this.runList];
    this.emit();
    const dir = this.outputDir(jobId, run.id);
    run.state = 'running';
    run.progress = 0.1;
    run.log.push(`output directory ${dir}`);
    this.emit();
    const release = this.docs.beginActivity();
    try {
      await this.session.mkdir(dir);
      let result = await this.execute(def, options, dir);
      if (result.running && result.job) {
        run.log.push(`job ${result.jobId} queued (async); polling GetJobStatus`);
        run.progress = 0.15;
        this.emit();
        result = await result.job.wait({
          intervalMs: 250,
          events: this.docs.kicadEvents ?? undefined,
          onProgress: (p) => {
            run.progress = Math.max(run.progress, Math.min(0.95, 0.15 + (p.percent / 100) * 0.8));
            const line = `${p.percent}% ${p.description}`.trim();
            if (p.description && run.log[run.log.length - 1] !== line) run.log.push(line);
            this.emit();
          },
        });
        run.log.push(`job ${result.jobId} finished: ${JobStatus[result.status] ?? result.status}`);
      }
      run.log.push(...result.message.split('\n').filter(Boolean));
      run.log.push(`KiCad reported ${result.outputPaths.length} output path(s)`);
      run.outputs = await this.collectOutputs(dir, result.outputPaths);
      run.log.push(`done: ${run.outputs.length} file(s), ${(run.outputs.reduce((a, o) => a + o.bytes, 0) / 1024).toFixed(1)} KiB`);
      run.state = 'done';
      run.progress = 1;
      this.log(`${def.command}: ${run.outputs.map((o) => o.name).join(', ') || 'no files'}`);
    } catch (e) {
      run.state = 'failed';
      run.error = e instanceof JobError ? `${e.message}${e.outputPaths?.length ? ` (${e.outputPaths.join(', ')})` : ''}` : e instanceof Error ? e.message : String(e);
      run.log.push(`error: ${run.error}`);
      this.log(`${def.command} failed: ${run.error}`, 'error');
    } finally {
      release();
      run.finishedAt = Date.now();
      this.emit();
    }
    return run;
  }

  private async execute(def: JobDefinition, o: Record<string, unknown>, dir: string): Promise<JobResult> {
    const board = this.docs.boardDoc;
    const sch = this.docs.schematicDoc;
    const bool = (k: string) => Boolean(o[k]);
    const units = o.units === 'in' ? Units.U_INCH : Units.U_MM;
    switch (def.id) {
      case 'board.svg':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportSvg(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.svg`, { plotSettings: { layers: layerEnums(o.layers), blackAndWhite: bool('blackAndWhite'), mirror: bool('mirror') }, fitPageToBoard: bool('fitPageToBoard') }, JOB);
      case 'board.gerbers':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportGerbers(`${dir}/`, {
          plotSettings: { layers: layerEnums(o.layers) },
          useProtelFileExtensions: bool('useProtelExtensions'),
          includeNetlistAttributes: bool('includeNetlistAttributes'),
          createGerberJobFile: bool('createGerberJobFile'),
          useX2Format: true,
          precision: o.precision === '4.5' ? GerberPrecision.GP_5 : GerberPrecision.GP_6,
        }, JOB);
      case 'board.drill':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportDrill(`${dir}/`, {
          format: o.format === 'gerber' ? DrillFormat.DF_GERBER : DrillFormat.DF_EXCELLON,
          units,
          origin: o.origin === 'plot' ? DrillOrigin.DO_PLOT : DrillOrigin.DO_ABSOLUTE,
          mapFormat: bool('generateMap') ? DrillMapFormat.DMF_PDF : DrillMapFormat.DMF_UNKNOWN,
        }, JOB);
      case 'board.position':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportPosition(`${dir}/`, {
          units,
          side: o.side === 'front' ? PositionSide.PS_FRONT : o.side === 'back' ? PositionSide.PS_BACK : PositionSide.PS_BOTH,
          smdOnly: bool('smdOnly'),
          excludeDnp: bool('excludeDnp'),
        }, JOB);
      case 'board.pdf':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportPdf(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.pdf`, { plotSettings: { layers: layerEnums(o.layers), blackAndWhite: bool('blackAndWhite') } }, JOB);
      case 'board.step':
        if (!board) throw new Error('no board is open');
        return board.jobs.export3D(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.step`, {
          format: Board3DFormat.B3D_STEP,
          substituteModels: bool('substituteModels'),
          includeDnp: bool('includeDnp'),
          includeUnspecified: bool('includeUnspecified'),
          exportTracksAndVias: bool('exportTracksAndVias'),
          exportZones: bool('exportZones'),
          fuseShapes: bool('fuseShapes'),
          optimizeStep: bool('optimizeStep'),
          exportBoardBody: true,
          exportComponents: true,
          usePcbCenterOrigin: o.origin === 'center',
          useGridOrigin: o.origin === 'grid',
          useDrillOrigin: o.origin === 'drill',
          overwrite: true,
        }, JOB);
      case 'board.glb':
        if (!board) throw new Error('no board is open');
        return board.jobs.export3D(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.glb`, {
          format: Board3DFormat.B3D_GLB,
          substituteModels: o.substituteModels === undefined ? true : bool('substituteModels'),
          includeDnp: bool('includeDnp'),
          includeUnspecified: true,
          exportBoardBody: true,
          exportComponents: true,
          exportTracksAndVias: o.exportTracksAndVias === undefined ? true : bool('exportTracksAndVias'),
          exportPads: true,
          exportZones: o.exportZones === undefined ? true : bool('exportZones'),
          exportSilkscreen: o.exportSilkscreen === undefined ? true : bool('exportSilkscreen'),
          exportSoldermask: o.exportSoldermask === undefined ? true : bool('exportSoldermask'),
          usePcbCenterOrigin: true,
          overwrite: true,
        }, JOB);
      case 'board.ipc2581':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportIpc2581(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.xml`, {
          units,
          version: o.version === 'B' ? Ipc2581Version.IPC2581V_B : Ipc2581Version.IPC2581V_C,
          precision: Number(o.precision ?? 3),
          compress: bool('compress'),
          bomRevision: String(o.bomRevision ?? ''),
          manufacturerPartNumberColumn: String(o.mpnColumn ?? ''),
          manufacturerColumn: String(o.manufacturerColumn ?? ''),
        }, JOB);
      case 'board.odb':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportOdb(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}-odb${o.compression === 'zip' ? '.zip' : o.compression === 'tgz' ? '.tgz' : ''}`, {
          units,
          precision: Number(o.precision ?? 2),
          compression: o.compression === 'none' ? OdbCompression.ODBC_NONE : o.compression === 'tgz' ? OdbCompression.ODBC_TGZ : OdbCompression.ODBC_ZIP,
        }, JOB);
      case 'board.dxf':
        if (!board) throw new Error('no board is open');
        // DXF wants a file name (a directory fails with "Failed to create file"); KiCad writes one file per layer next to it
        return board.jobs.exportDxf(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.dxf`, { plotSettings: { layers: layerEnums(o.layers) } }, JOB);
      case 'schematic.svg':
        if (!sch) throw new Error('no schematic is open');
        return sch.jobs.exportSvg(`${dir}/`, { plotSettings: { blackAndWhite: bool('blackAndWhite'), plotDrawingSheet: bool('plotDrawingSheet'), plotAll: true } }, JOB);
      case 'schematic.pdf':
        if (!sch) throw new Error('no schematic is open');
        return sch.jobs.exportPdf(`${dir}/${sch.name || 'schematic'}.pdf`, { plotSettings: { blackAndWhite: bool('blackAndWhite'), plotDrawingSheet: bool('plotDrawingSheet'), plotAll: true }, hierarchicalLinks: bool('hierarchicalLinks') }, JOB);
      case 'schematic.bom':
        if (!sch) throw new Error('no schematic is open');
        return sch.jobs.exportBom(`${dir}/${sch.name || 'schematic'}-bom.csv`, { excludeDnp: bool('excludeDnp'), groupSymbols: bool('groupSymbols') }, JOB);
      case 'schematic.netlist':
        if (!sch) throw new Error('no schematic is open');
        return sch.jobs.exportNetlist(`${dir}/${(sch.name || 'schematic').replace(/\.kicad_sch$/, '')}.${o.format === 'xml' ? 'xml' : 'net'}`, { format: o.format === 'xml' ? SchematicNetlistFormat.SNF_KICAD_XML : SchematicNetlistFormat.SNF_KICAD_SEXPR }, JOB);
      default:
        throw new Error(`job ${def.id} has no runner`);
    }
  }

  /** Lists the output folder through the bridge and merges the paths KiCad reported. */
  private async collectOutputs(dir: string, reported: string[]): Promise<JobOutput[]> {
    const out = new Map<string, JobOutput>();
    const add = (path: string, bytes: number) => {
      const name = path.split('/').pop() ?? path;
      out.set(path, { name, path: path.slice(0, path.lastIndexOf('/')), bytes, mime: mimeFor(name), url: this.session.fileUrl(path) });
    };
    try {
      for (const e of await this.session.listFiles(dir)) if (e.kind === 'file') add(e.path, e.size ?? 0);
    } catch {
      /* folder may be elsewhere or outside the workspace */
    }
    for (const p of reported) {
      if (out.has(p)) continue;
      const st = await this.session.stat(p);
      if (st?.kind === 'file') add(p, st.size);
      else if (st?.kind === 'dir') {
        try {
          for (const e of await this.session.listFiles(p)) if (e.kind === 'file') add(e.path, e.size ?? 0);
        } catch {
          /* ignore */
        }
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

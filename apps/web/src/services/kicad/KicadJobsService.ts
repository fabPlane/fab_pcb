// JobsService over the RunBoardJobExport* / RunSchematicJobExport* commands. Every run
// writes into `<project dir>/kicad-web-out/<job>-<n>/` (inside the bridge workspace root, so
// `/files/list` can enumerate the outputs and `/files/read` can serve them) and reports the
// files KiCad returned in `RunJobResponse.output_path` plus whatever appeared in the folder.
//
// `RunSchematicJobExportNetlist` is deliberately absent: it never answers headless and
// wedges the server (packages/client/dist/conformance-summary.txt).

import { BoardLayer, Board3DFormat, DrillFormat, DrillMapFormat, DrillOrigin, GerberPrecision, PositionSide, Units } from '@kicad-web/proto';
import { JobError, type JobResult } from '@kicad-web/client';
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
      title: 'STEP / GLB 3D model',
      description: 'Export the board with 3D models (RunBoardJobExport3D).',
      document: 'board',
      command: 'RunBoardJobExport3D',
      options: [
        { key: 'format', label: 'Format', type: 'select', default: 'step', choices: [{ value: 'step', label: 'STEP' }, { value: 'glb', label: 'GLB (binary glTF)' }] },
        { key: 'substituteModels', label: 'Substitute STEP for VRML models', type: 'boolean', default: true },
        { key: 'includeDnp', label: 'Include DNP', type: 'boolean', default: false },
      ],
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
      const result = await this.execute(def, options, dir);
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
        return board.jobs.exportSvg(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.svg`, { plotSettings: { layers: layerEnums(o.layers), blackAndWhite: bool('blackAndWhite'), mirror: bool('mirror') }, fitPageToBoard: bool('fitPageToBoard') });
      case 'board.gerbers':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportGerbers(`${dir}/`, {
          plotSettings: { layers: layerEnums(o.layers) },
          useProtelFileExtensions: bool('useProtelExtensions'),
          includeNetlistAttributes: bool('includeNetlistAttributes'),
          createGerberJobFile: bool('createGerberJobFile'),
          useX2Format: true,
          precision: o.precision === '4.5' ? GerberPrecision.GP_5 : GerberPrecision.GP_6,
        });
      case 'board.drill':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportDrill(`${dir}/`, {
          format: o.format === 'gerber' ? DrillFormat.DF_GERBER : DrillFormat.DF_EXCELLON,
          units,
          origin: o.origin === 'plot' ? DrillOrigin.DO_PLOT : DrillOrigin.DO_ABSOLUTE,
          mapFormat: bool('generateMap') ? DrillMapFormat.DMF_PDF : DrillMapFormat.DMF_UNKNOWN,
        });
      case 'board.position':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportPosition(`${dir}/`, {
          units,
          side: o.side === 'front' ? PositionSide.PS_FRONT : o.side === 'back' ? PositionSide.PS_BACK : PositionSide.PS_BOTH,
          smdOnly: bool('smdOnly'),
          excludeDnp: bool('excludeDnp'),
        });
      case 'board.pdf':
        if (!board) throw new Error('no board is open');
        return board.jobs.exportPdf(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.pdf`, { plotSettings: { layers: layerEnums(o.layers), blackAndWhite: bool('blackAndWhite') } });
      case 'board.step':
        if (!board) throw new Error('no board is open');
        return board.jobs.export3D(`${dir}/${board.name.replace(/\.kicad_pcb$/, '')}.${o.format === 'glb' ? 'glb' : 'step'}`, {
          format: o.format === 'glb' ? Board3DFormat.B3D_GLB : Board3DFormat.B3D_STEP,
          substituteModels: bool('substituteModels'),
          includeDnp: bool('includeDnp'),
          overwrite: true,
        });
      case 'schematic.svg':
        if (!sch) throw new Error('no schematic is open');
        return sch.jobs.exportSvg(`${dir}/`, { plotSettings: { blackAndWhite: bool('blackAndWhite'), plotDrawingSheet: bool('plotDrawingSheet'), plotAll: true } });
      case 'schematic.pdf':
        if (!sch) throw new Error('no schematic is open');
        return sch.jobs.exportPdf(`${dir}/${sch.name || 'schematic'}.pdf`, { plotSettings: { blackAndWhite: bool('blackAndWhite'), plotDrawingSheet: bool('plotDrawingSheet'), plotAll: true }, hierarchicalLinks: bool('hierarchicalLinks') });
      case 'schematic.bom':
        if (!sch) throw new Error('no schematic is open');
        return sch.jobs.exportBom(`${dir}/${sch.name || 'schematic'}-bom.csv`, { excludeDnp: bool('excludeDnp'), groupSymbols: bool('groupSymbols') });
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
